export const tools = [
  {
    type: "function",
    function: {
      name: "create_folder",
      description:
        "Create a folder inside the application's workspace directory.",
      parameters: {
        type: "object",
        properties: {
          folderName: {
            type: "string",
            description:
              "Name of the folder to create, without path separators.",
          },
        },
        required: ["folderName"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "list_files",
      description: "List regular files and folders in the workspace directory. Symbolic links and special entries are omitted.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a new empty file inside the workspace directory.",
      parameters: {
        type: "object",
        properties: {
          fileName: {
            type: "string",
            description:
              "Name of the file including its extension, such as notes.txt",
          },
        },
        required: ["fileName"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "write_file",

      description:
        "Create a new file containing text inside the workspace directory. All existing files, including empty files, are rejected. Call this tool directly when creating a file with content; do not call create_file first.",

      parameters: {
        type: "object",

        properties: {
          fileName: {
            type: "string",
            description:
              "Name of the file including extension, such as testPlan.txt",
          },

          content: {
            type: "string",
            description: "The complete text content to write into the file",
          },
        },

        required: ["fileName", "content"],

        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "read_file",

      description:
        "Read the contents of a text file inside the workspace directory.",

      parameters: {
        type: "object",

        properties: {
          fileName: {
            type: "string",
            description: "Name of the file to read, including its extension.",
          },
        },

        required: ["fileName"],

        additionalProperties: false,
      },
    },
  }
];

