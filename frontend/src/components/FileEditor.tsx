import * as React from "react";

import APIRequest from "../api/Request";
import createWebSocket from "../api/WebSocket";

import { styled } from "@mui/material/styles";
import {
  Select,
  Box,
  ButtonGroup,
  MenuItem,
  SelectChangeEvent,
} from "@mui/material";
import Tooltip, { TooltipProps, tooltipClasses } from "@mui/material/Tooltip";
import Button from "@mui/material/Button";
import Snackbar from "@mui/material/Snackbar";

import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";

import MuiAlert, { AlertProps } from "@mui/material/Alert";

import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";

// monaco-editor
import "monaco-editor/esm/vs/editor/editor.all.js";

import "monaco-editor/esm/vs/editor/standalone/browser/accessibilityHelp/accessibilityHelp.js";
import "monaco-editor/esm/vs/editor/standalone/browser/inspectTokens/inspectTokens.js";
import "monaco-editor/esm/vs/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js";
import "monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js";
import "monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js";
import "monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js";
import "monaco-editor/esm/vs/editor/standalone/browser/quickInput/standaloneQuickInputService.js";
import "monaco-editor/esm/vs/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js";
import "monaco-editor/esm/vs/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js";
// monaco-editor api
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
// monaco-editor workers
import { buildWorkerDefinition } from "monaco-editor-workers";
// monaco-editor react
import Editor, { Monaco } from "@monaco-editor/react";
import { loader } from "@monaco-editor/react";
// vscode-services
import { StandaloneServices } from "vscode/services";
import getMessageServiceOverride from "vscode/service-override/messages";

// monaco-languageclient
import {
  MonacoLanguageClient,
  MonacoServices,
  MessageTransports,
  WorkspaceFolder,
} from "monaco-languageclient";
import {
  toSocket,
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from "vscode-ws-jsonrpc";
import selectLanguageForEndpoint from "./MonacoLanguageSelector";

// yjs collaboration
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
//import { WebrtcProvider } from 'y-webrtc'
import { MonacoBinding } from "y-monaco";
import { toUint8Array } from "js-base64";

loader.config({ monaco });

StandaloneServices.initialize({
  ...getMessageServiceOverride(document.body),
});
buildWorkerDefinition(
  "dist",
  new URL("../../", window.location.href).href,
  false
);

type Severity = "error" | "success" | "info" | "warning" | undefined;

interface State {
  fileState: FileState;
  currentFile: string;
  currentFileChanged: boolean;
  currentFileLSPLanguage: string;
  currentFilePath: string;
  editorResult: string;
  editorSeverity: Severity;
  editorNotificationOpen: boolean;
  editorConfirmationDialogOpen: boolean;
}

interface FileState {
  [key: string]: FileStateModel;
}

interface FileStateModel {
  name: string;
  editorLanguage: string;
  lspLanguage: string;
  value: string;
  fileChanged: boolean;
  fileLocation: string;
}

interface FileEditorProps {
  files: string[];
  filePaths: string[];
  environment: string;
  rootPath: string;
  workspaceFolders: string[];
  useCollaboration: boolean;
  useLanguageClient: boolean;
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(
  props,
  ref
) {
  return <MuiAlert elevation={6} ref={ref} variant="filled" {...props} />;
});

class KeepAliveAwareWebSocketMessageReader extends WebSocketMessageReader {
  protected readMessage(message: any): void {
    if (message === "pong") {
      // ignore pong keep-alive message from backend
      //console.log("received pong from backend");
    } else {
      //console.log("received message from backend: " + message);
      super.readMessage(message);
    }
  }
}

// maybe consider to move collaboration and languageclient to class augmentation again?
export default class FileEditor extends React.Component<FileEditorProps> {
  public state: State;

  private editor!: monaco.editor.IStandaloneCodeEditor;

  private environmentFiles = {} as FileState;

  private username: string;
  private group: string;

  private binding?: MonacoBinding;
  private collaborationProvider?: WebsocketProvider;
  //private collaborationProvider?: WebrtcProvider;
  private suppressChangeDetection = false;

  private languageClient!: MonacoLanguageClient;
  private languageClientWSTimerId!: NodeJS.Timeout;
  private languageClientWSTimeout: number = 10000;

  private languageClientWebSocket!: WebSocket;


  constructor(props: FileEditorProps) {
    super(props);
    this.state = {
      fileState: {} as FileState,
      currentFile: props.files[0],
      currentFileChanged: false,
      currentFileLSPLanguage: "",
      currentFilePath: "",
      editorResult: "",
      editorSeverity: "info",
      editorNotificationOpen: false,
      editorConfirmationDialogOpen: false,
    };

    this.username = localStorage.getItem("username") ?? "default-user";
    this.group = localStorage.getItem("group") ?? "0";

    this.save = this.save.bind(this);
    this.load = this.load.bind(this);

    this.editorDidMount = this.editorDidMount.bind(this);
    this.editorWillMount = this.editorWillMount.bind(this);
    this.onChange = this.onChange.bind(this);

    this.startCollaborationServices =
      this.startCollaborationServices.bind(this);
    this.stopCollaborationServices = this.stopCollaborationServices.bind(this);

    this.startLanguageClient = this.startLanguageClient.bind(this);
    this.stopLanguageClient = this.stopLanguageClient.bind(this);

    // register Monaco languages
    monaco.languages.register({
      id: "c",
      extensions: [".c", ".h"],
      aliases: ["C", "c"],
    });

    monaco.languages.register({
      id: "p4",
      extensions: [".p4"],
      aliases: ["p4", "P4"],
    });

    monaco.languages.register({
      id: "python",
      extensions: [".py"],
      aliases: ["Python", "py", "PY", "python"],
    });

    monaco.languages.register({
      id: "json",
      extensions: [
        ".json",
        ".bowerrc",
        ".jshintrc",
        ".jscsrc",
        ".eslintrc",
        ".babelrc",
      ],
      aliases: ["JSON", "json"],
      mimetypes: ["application/json"],
    });
    // additional file types? make them configurable?

    // install Monaco language client services
    const options: MonacoServices.Options = {};
    // maybe remove ?? part and also findCommonPathPrefix and only allow rootPath and workspaceFolders
    options.rootPath =
      this.props.rootPath ?? this.findCommonPathPrefix(this.props.filePaths);
    let workspaceFolders = [] as WorkspaceFolder[];
    if (this.props.workspaceFolders?.length > 0) {
      this.props.workspaceFolders.forEach((workspaceDir) => {
        // also support \ in paths?
        workspaceFolders.push({
          name: workspaceDir,
          uri: "file://" + workspaceDir,
        });
      });
      options.workspaceFolders = workspaceFolders;
    } else {
      // maybe remove this part and also findCommonPathPrefix and only allow rootPath and workspaceFolders
      // to be specified in configuration?
      // test if essential languageClient features also work when rootPath and workspaceFolders are empty
      this.props.filePaths.forEach((filePath) => {
        // also support \ in paths?
        const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
        workspaceFolders.push({
          name: fileDir,
          uri: fileDir,
        });
      });
    }
    options.workspaceFolders = workspaceFolders;
    MonacoServices.install(options);
  }

  async editorWillMount(_monaco: Monaco) {
    await Promise.all(
      this.props.files.map(async (fileName) => {
        await fetch(
          APIRequest(
            `/api/environment/${this.props.environment}/file/${fileName}`,
            {
              headers: {
                "Content-Type": "application/json",
                authorization: localStorage.getItem("token") || "",
              },
            }
          )
        )
          .then((response) => {
            const contentLocation = response.headers.get("Content-Location");
            return { text: response.text(), location: contentLocation };
          })
          .then(async (data) => {
            const fileContent = await data.text;

        this.environmentFiles[fileName] = {
          value: fileContent,
          editorLanguage: selectLanguageForEndpoint(fileName).editorLanguage,
          lspLanguage: selectLanguageForEndpoint(fileName).lspLanguage,
          name: fileName,
          fileChanged: false,
          fileLocation: data.location ?? "",
        }

        // check number of models in editor? sometimes additional/superfluous inmemory model shows up
        // should only contain the files that are used in the env as entries in the model?
        console.log("finished loading editor files...");
      })
      .catch((err) => {
        console.error(err);
      })
    }))

    const initialFile = this.props.files[0];
    const file = this.environmentFiles[initialFile];
    this.setState({
      currentFile: file.name,
      currentFilePath: file.fileLocation,
      currentFileEditorLanguage: file.editorLanguage,
      currentFileLSPLanguage: file.lspLanguage,
    });

    console.log("Loading editor file: " + file.name + " with editorLanguage: " + file.editorLanguage + " and lspLanguage: " + file.lspLanguage);
    this.startLanguageClient(this.editor, file.lspLanguage);

    this.suppressChangeDetection = true;
    await this.startCollaborationServices(this.group, this.state.currentFile);
    this.suppressChangeDetection = false;
  }

  async editorDidMount(
    editor: monaco.editor.IStandaloneCodeEditor,
    _monaco: Monaco
  ) {
    this.editor = editor;
    //editor.focus();
  }

  componentWillUnmount(): void {
    this.stopCollaborationServices();
    this.stopLanguageClient();
  }

  /****************************************
   **
   ** Collaboration Services
   **
   ****************************************/

  getRandomInt(min: number, max: number) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min) + min); // The maximum is exclusive and the minimum is inclusive
  }
  

  async startCollaborationServices(group: string, fileName: string) {
    if (!this.props.useCollaboration) {
      // collaboration disabled in config for this env do not start it and simply return
      return;
    }

    const collaborationId = fileName + "-group" + group;
    console.log(
      "Starting collaboration for user: " +
        this.username +
        " in group: " +
        group +
        " on: " +
        collaborationId
    );

    const doc = new Y.Doc();

    const result = await fetch(
      APIRequest(
        `/api/environment/${this.props.environment}/collabdoc/${fileName}`,
        {
          headers: {
            "Content-Type": "application/json",
            authorization: localStorage.getItem("token") || "",
          },
        }
      )
    );
    if (result.status === 200) {
      const content = await result.text();
      Y.applyUpdate(doc, toUint8Array(content));

      // Websocket provider
      this.collaborationProvider = new WebsocketProvider(
        `${window?.location?.protocol === "http:" || undefined ? "ws:" : "wss:"}//` +
          (import.meta.env.VITE_REACT_APP_YJS_WEBSOCKET_HOST ??
            window?.location?.hostname ??
            `localhost`) +
          `:` +
          (import.meta.env.VITE_REACT_APP_YJS_WEBSOCKET_PORT ?? `1234`),
        collaborationId,
        doc
      );

      // WebRTC provider alternative
      // this.collaborationProvider = new WebrtcProvider(
      //   collaborationId,
      //   doc,
      //   {
      //     signaling: [
      //       `${window?.location?.protocol === "http:" || undefined ? "ws:" : "wss:"}//` +
      //         (import.meta.env.VITE_REACT_APP_YJS_WEBRTC_HOST ??
      //         window?.location?.hostname ??
      //         `localhost`) +
      //         `:` +
      //         (import.meta.env.VITE_REACT_APP_YJS_WEBRTC_PORT ?? `4444`),
      //     ],
      //   }
      // );

      const type = doc.getText("monaco");

      const awareness = this.collaborationProvider.awareness;
      const username = this.username;

      const red = this.getRandomInt(64,192);
      const green = this.getRandomInt(64,192);
      const blue = this.getRandomInt(64,192);
      let hexColor = '#' + red.toString(16).padStart(2, '0')+ green.toString(16).padStart(2, '0') + blue.toString(16).padStart(2, '0');
      console.log("my color: " + hexColor);

      awareness.on('update', ({ added = [] /*, updated = [], removed = [] */}) => {
        added.forEach((client) => {
          //yjs awareness debug:
          //console.log("added client: " + client);
          //
          //awareness.getStates().forEach((state, clientId) => {
          //  console.log("client state: " + clientId + " state: " + state.user.name + " color: " + state.user.color);
          //});

          // add css class for new client
          if (awareness.getStates().get(client) !== undefined) {
            const { name, color } = awareness.getStates().get(client)!.user;
            const colorRed = parseInt(color.substring(1,3), 16);
            const colorGreen = parseInt(color.substring(3,5), 16);
            const colorBlue = parseInt(color.substring(5,7), 16);
            const newClient = document.createElement("style");
            //newClient.type = "text/css";
            newClient.innerHTML = `
            .yRemoteSelection-${client} {
              background-color: rgb(${colorRed}, ${colorGreen}, ${colorBlue}, .5)
            }
            .yRemoteSelection-${client}:hover {
              position: relative;
              content: ${name};
              border: 1px solid #222222;
              left: -4px;
              top: -5px;
            }
            .yRemoteSelectionHead-${client} {
              position: absolute;
              border-left: ${color} solid 2px;
              border-top: ${color} solid 2px;
              border-bottom: ${color} solid 2px;
              height: 100%;
              box-sizing: border-box;
            }          
            .yRemoteSelectionHead-${client}::after {
              position: absolute;
              content: ' ';
              border: 3px solid ${color};
              border-radius: 4px;
              left: -4px;
              top: -5px;
            }
            .yRemoteSelectionHead-${client}::before {
                position: absolute;
                white-space: nowrap;
                color: rgb(${colorRed}, ${colorGreen}, ${colorBlue}, .5);
                text-shadow: 0 0 2px #000000;
                opacity: 1.0;
                font-size: 12px;
                font-family: sans-serif;
                z-index: 4000;
                content: "${name}";
                opacity: 1.0;
                left: 4px;
                top: -12px;
                transition: opacity 0.5s ease-out;
                -webkit-transition: opacity 0.5s ease-out;
                -moz-transition: opacity 0.5s ease-out;
                -ms-transition: opacity 0.5s ease-out;
                -o-transition: opacity 0.5s ease-out;
              }
            }`;
            document.head.appendChild(newClient);
          }
        });
        //no need to handle updated and removed clients for now, styles will be kept and will not change
        //updated.forEach((client) => {
        //  console.log("updated client: " + client);
        //});
        //removed.forEach((client) => {
        //  console.log("removed client: " + client);
        //});
      });
      console.log("my client id: " + awareness.clientID);
      awareness.setLocalStateField("user", {
        name: username,
        color: hexColor,
      });

      if (this.editor != null) {
        if (this.editor.getModel()) {
          this.binding = new MonacoBinding(
            type,
            this.editor.getModel()!,
            new Set([this.editor]),
            awareness
          );
        } else {
          // should not happen, since editor is mounted
          console.log("MonacoBinding editor model is null");
        }
      } else {
        // should not happen, since editor is mounted
        console.log("MonacoBinding editor is null");
      }
    } else {
      console.log("Collab doc not found");
      //throw exception? Should not happen though, since collab doc is created on first access
    }
  }

  stopCollaborationServices() {
    if (!this.props.useCollaboration) {
      // collaboration disabled in config for this env do not start it and simply return
      return;
    }
    this.binding?.destroy();
    // WebRTC provider problem is room is taken, cannot be joined/created again
    //this.collaborationProvider?.room?.destroy();
    this.collaborationProvider?.disconnect();
  }

  /*******************************
  **
  ** Monaco Language Client
  **
  *******************************/

  startLanguageClient(editor: monaco.editor.IStandaloneCodeEditor, lspLanguage: string) {
    if (!this.props.useLanguageClient) {
      // languageClient disabled in config for this env do not start it and simply return
      return
    }

    if (lspLanguage !== "") {
      console.log("Starting language client for language: " + lspLanguage);

      this.languageClientWebSocket = createWebSocket('/environment/' + this.props.environment + '/languageserver/' + lspLanguage);

      this.languageClientWebSocket.onopen = () => {
          // create and start the language client

          // sending auth token to backend
          this.languageClientWebSocket.send(`auth ${localStorage.getItem("token")}`)

          // backend needs some time to process auth token and initiate
          // ws conn from backend to lsp, hence, wait for backend
          // response, otherwise language client initialization msg will
          // be sent to early and ignored

          // save onmessage fn
          //const defaultOnMessage = this.languageClientWebSocket.onmessage
          this.languageClientWebSocket.onmessage = (e) => {
              if (e.data === "backend websocket ready") {
                  // restore onmessage fn
                  console.log("backend websocket ready, starting language client");
                  //this.languageClientWebSocket.onmessage = (e) => {
                    //console.log("received message from backend: " + e.data);
                    //if (e.data === "pong") {
                      // ignore pong keep-alive message from backend
                    //}
                    //defaultOnMessage?.call(this.languageClientWebSocket, e);
                  //}

                  // keep connection alive
                  this.languageClientWSTimerId = setInterval(() => {
                    this.languageClientWebSocket.send("ping");
                  }, this.languageClientWSTimeout);

                  const socket = toSocket(this.languageClientWebSocket);
                  // need to implement own reader to ensure "pong" message is filtered...
                  const reader = new KeepAliveAwareWebSocketMessageReader(socket);
                  const writer = new WebSocketMessageWriter(socket);
                  this.languageClient = createLanguageClient({
                      reader,
                      writer
                  });
                  this.languageClient.start();
              }
          }
      };

    }

    function createLanguageClient(transports: MessageTransports): MonacoLanguageClient {
      const model = editor.getModel()
      const language = model?.getLanguageId() || ''
      return new MonacoLanguageClient({
          name: "Language Client",
          clientOptions: {
              // use a language id as a document selector
              documentSelector: [language],

              // workspaceFolder already set globally, no need to set it again, would only
              // be necessary if workspaceFolders should be different for each selected file
              //workspaceFolder: {
              //  uri: "file:///home/p4/"
              //},

              // disable the default error handler
              //errorHandler: {
                  //error: () => ({ action: ErrorAction.Continue }),
                  // maybe use restart of language client? e.g., to recover from conn loss? 
                  //closed: () => ({ action: CloseAction.Restart })
              //}
          },
          // create a language client connection from the JSON RPC connection on demand
          connectionProvider: {
              get: () => {
                  return Promise.resolve(transports);
              }
          }
      });
    }
  }

  stopLanguageClient() {
    if (!this.props.useLanguageClient) {
      // languageClient disabled in config for this env do not start it and simply return
      return
    }

    // if languageClient connection was closed, this.languageClient will be undefined
    this.languageClient?.dispose();
    clearInterval(this.languageClientWSTimerId);
    //this.languageClientWebSocket.close()
  }

  findCommonPathPrefix(strings: string[]): string {
    let commonPrefix = "";
    const stringA = strings[0];
    // cycle thgouh remaining strings after the first and check for common prefix
    strings.forEach((stringB) => {
      let tempCommonPrefix = "";
      const shortestLength = Math.min(stringA.length, stringB.length);
      for (let length = 1; length < shortestLength; length++) {
        const prefix = stringB.substring(0, length);
        if (stringA.includes(prefix)) {
          tempCommonPrefix = prefix;
        }
      }
      // if commonPrefix was not already set
      if (commonPrefix.length === 0) {
        if (tempCommonPrefix.length > 0) {
          commonPrefix = tempCommonPrefix;
        } else {
          // no common prefix
          return "";
        }
      } else {
        // if new tempCommonPrefix is now shorter -> update commonPrefix
        if (tempCommonPrefix.length < commonPrefix.length) {
          commonPrefix = tempCommonPrefix;
        }
      }
    });
    // remove training / or \ from commonPath
    // \\ currently not used?
    while (commonPrefix.endsWith("/") || commonPrefix.endsWith("\\")) {
      commonPrefix = commonPrefix.slice(0, -1);
    }
    return commonPrefix;
  }

  onChange(_value: string | undefined) {
    if (this.suppressChangeDetection) {
      return;
    }
    this.environmentFiles[this.state.currentFile].fileChanged = true;
    this.setState({ currentFileChanged: true });
    //console.log("File changed: " + this.state.currentFile);
  }

  async save(): Promise<void> {
    this.setState({
      editorResult: "Saving file...",
      editorSeverity: "info",
      editorNotificationOpen: true,
    });
    try {
      const result = await fetch(
        APIRequest(
          `/api/environment/${this.props.environment}/file/${this.state.currentFile}`,
          {
            method: "post",
            body: this.editor.getModel()?.getValue(),
            headers: {
              "Content-Type": "text/plain",
              authorization: localStorage.getItem("token") || "",
            },
          }
        )
      );
      if (result.status === 200) {
        this.environmentFiles[this.state.currentFile].fileChanged = false;
        this.setState({
          currentFileChanged: false,
          editorResult: "Deploy successful!",
          editorSeverity: "success",
          editorNotificationOpen: true,
        });
      } else {
        const message = await result.json();
        this.setState({
          editorResult: "Deploy failed! (" + message.message + ")",
          editorSeverity: "error",
          editorNotificationOpen: true,
        });
      }
    } catch (error) {
      this.setState({
        editorResult: "Deploy failed! (" + error + ")",
        editorSeverity: "error",
        editorNotificationOpen: true,
      });
    }
    this.editor.focus();
  }

  async load(): Promise<void> {
    this.setState({
      editorConfirmationDialogOpen: true,
      editorResult: "Loading file...",
      editorSeverity: "info",
      editorNotificationOpen: true,
    });
    try {
      const result = await fetch(
        APIRequest(
          `/api/environment/${this.props.environment}/file/${this.state.currentFile}`,
          {
            headers: {
              "Content-Type": "application/json",
              authorization: localStorage.getItem("token") || "",
            },
          }
        )
      );
      if (result.status === 200) {
        const content = await result.text();
        this.environmentFiles[this.state.currentFile].value = content;
        this.environmentFiles[this.state.currentFile].fileChanged = false;
        this.editor.setValue(content);
        this.setState({
          currentFileChanged: false,
          editorResult: "Retrieve successful!",
          editorSeverity: "success",
          editorNotificationOpen: true,
        });
      } else {
        const content = await result.json();
        this.setState({
          editorResult: "Retrieve failed! (" + content.message + ")",
          editorSeverity: "error",
          editorNotificationOpen: true,
        });
      }
    } catch (error) {
      this.setState({
        editorResult: "Retrieve failed! (" + error + ")",
        editorSeverity: "error",
        editorNotificationOpen: true,
      });
    }
    this.editor.focus();
  }

  render(): JSX.Element {
    const handleEditorNotificationClose = () => {
      this.setState({ editorNotificationOpen: false });
    };

    const handleEditorConfirmationDialogOpen = () => {
      this.setState({ editorConfirmationDialogOpen: true });
    };

    const handleEditorConfirmationDialogClose = () => {
      this.setState({ editorConfirmationDialogOpen: false });
    };

    const handleEditorConfirmationDialogConfirm = () => {
      this.load();
      this.setState({ editorConfirmationDialogOpen: false });
    };

    const changeFile = (event: SelectChangeEvent) => {
      this.stopCollaborationServices();
      this.stopLanguageClient();
      this.setState({
        currentFile: event.target.value,
        currentFilePath: this.environmentFiles[event.target.value].fileLocation,
        currentFileEditorLanguage:
          this.environmentFiles[event.target.value].editorLanguage,
        currentFileLSPLanguage:
          this.environmentFiles[event.target.value].lspLanguage,
        currentFileChanged:
          this.environmentFiles[event.target.value].fileChanged,
      });
      this.startCollaborationServices(this.group, event.target.value);
      this.startLanguageClient(
        this.editor,
        selectLanguageForEndpoint(event.target.value).lspLanguage
      );
    };

    const closeSelect = (_event: React.SyntheticEvent) => {
      this.editor?.focus();
    };

    const monacoOptions = {
      automaticLayout: true,
      glyphMargin: true,
      lightbulb: {
        enabled: true,
      },
    };

    const CustomWidthTooltip = styled(
      ({ className, ...props }: TooltipProps) => (
        <Tooltip {...props} classes={{ popper: className }} />
      )
    )({
      [`& .${tooltipClasses.tooltip}`]: {
        maxWidth: "100%",
      },
    });

    return (
      <Box className="myMonacoClass">
        <Box sx={{ display: "flex" }}>
          <ButtonGroup
            variant="contained"
            color="primary"
            style={{ flexShrink: 0, margin: "2px" }}
          >
            <Button
              variant="contained"
              color="primary"
              disabled={!this.state.currentFileChanged}
              startIcon={<CloudUploadIcon />}
              onClick={this.save}
            >
              Deploy
            </Button>
            <Button
              variant="contained"
              color="primary"
              startIcon={<CloudDownloadIcon />}
              onClick={handleEditorConfirmationDialogOpen}
            >
              Retrieve
            </Button>
          </ButtonGroup>
          <CustomWidthTooltip
            title={
              "Path: " +
              this.state.currentFilePath +
              ", Language: " +
              this.state.currentFileLSPLanguage
            }
            placement="top-start"
          >
            {/* onAnimationEnd to focus editor after changing selection and onTransitionEnd to focus editor after selecting the same entry */}
            <Select
              onChange={changeFile}
              onAnimationEnd={closeSelect}
              onTransitionEnd={closeSelect}
              sx={{ width: "100%" }}
              value={this.state.currentFile}
            >
              {this.props.files.map((fileName) => (
                <MenuItem key={fileName} value={fileName}>
                  {fileName}
                </MenuItem>
              ))}
            </Select>
          </CustomWidthTooltip>
        </Box>
        <Editor
          width="100%"
          height="100%"
          theme="vs-dark"
          options={monacoOptions}
          defaultValue={this.environmentFiles[this.state.currentFile]?.value}
          defaultLanguage={
            this.environmentFiles[this.state.currentFile]?.editorLanguage
          }
          path={this.environmentFiles[this.state.currentFile]?.fileLocation}
          onChange={this.onChange}
          beforeMount={this.editorWillMount}
          onMount={this.editorDidMount}
        />
        <Snackbar
          open={this.state.editorNotificationOpen}
          autoHideDuration={6000}
          onClose={handleEditorNotificationClose}
        >
          <Alert
            onClose={handleEditorNotificationClose}
            severity={this.state.editorSeverity as Severity}
          >
            {this.state.editorResult}
          </Alert>
        </Snackbar>
        <Dialog
          open={this.state.editorConfirmationDialogOpen}
          onClose={handleEditorConfirmationDialogClose}
          aria-describedby="alert-dialog-description"
        >
          <DialogContent>
            <DialogContentText id="alert-dialog-description">
              Retrieve file content from host?
              <br />
              Undeployed changes will be lost.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={handleEditorConfirmationDialogClose}
              color="primary"
              autoFocus
            >
              No
            </Button>
            <Button
              onClick={handleEditorConfirmationDialogConfirm}
              color="primary"
            >
              Yes
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    );
  }
}
