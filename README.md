# AI Task Assistant

[![Automated Tests](https://github.com/sivanishanthar/ai-task-assistant/actions/workflows/nodejs-tests.yml/badge.svg)](https://github.com/sivanishanthar/ai-task-assistant/actions/workflows/nodejs-tests.yml)

A simple AI-powered task assistant built with **Node.js, JavaScript, and the OpenAI API**.

I started this project to get hands-on experience building AI agents and understanding how they can interact with real tools. Instead of just answering questions, this assistant can carry out basic file and folder operations based on instructions entered in natural language.

The project also gave me an opportunity to apply my experience in QA automation by building automated tests, measuring code coverage, and setting up a CI/CD pipeline using GitHub Actions.

## What Can It Do?

The assistant currently supports five operations:

- **Create folders** — Create a new folder inside the application's workspace.
- **Create files** — Create a new empty file without replacing an existing one.
- **List files and folders** — See what is currently stored in the workspace.
- **Write to files** — Create a new file containing text. All existing files, including empty files, are protected.
- **Read files** — Read the contents of a text file, with a 100 KB size limit.

The assistant also remembers the conversation while it's running, so users can continue interacting with it without starting a new session for every request.

## How It Works

The application runs in the terminal. When a user enters a request, it sends the message to the OpenAI API along with a list of available tools.

The AI decides whether it needs to use one of those tools. If a tool is needed, the application executes the appropriate JavaScript function and sends the result back to the AI.

The assistant then displays the response in the terminal.

```text
       User enters a request
                 |
                 v
          AI Task Assistant
                 |
                 v
             OpenAI API
                 |
                 v
        Selects a tool to use
                 |
                 v
       JavaScript tool executes
                 |
                 v
         Local workspace/
                 |
                 v
        Result returned to AI
                 |
                 v
       Response shown to user
```

For example, if I ask the assistant to create a file called `notes.txt`, it can use the `create_file` tool to create the file inside the workspace.

## Technologies Used

| Technology | How It's Used |
| --- | --- |
| JavaScript | Application and tool development |
| Node.js | Running the application |
| OpenAI API | Understanding requests and selecting tools |
| GPT-4o mini | AI model used by the assistant |
| dotenv | Managing environment variables |
| Node.js Test Runner | Automated unit testing |
| GitHub Actions | Running tests automatically |
| Git and GitHub | Version control and source code management |

## Project Structure

```text
ai-task-assistant/
│
├── .github/
│   └── workflows/
│       └── nodejs-tests.yml
│
├── src/
│   ├── agent.js
│   └── tools/
│       ├── folderTool.js
│       ├── createFileTool.js
│       ├── listFilesTool.js
│       ├── writeFileTool.js
│       └── readFileTool.js
│
├── tests/
│   ├── folderTool.test.js
│   ├── createFileTool.test.js
│   ├── listFileTool.test.js
│   ├── writeFileTool.test.js
│   └── readFileTool.test.js
│
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
└── README.md
```

Files and folders created by the assistant are stored in a local `workspace/` directory. This directory is excluded from Git.

## Getting Started

You'll need Node.js, npm, and an OpenAI API key to run the assistant. I use Node.js 22 for the automated CI tests.

### 1. Clone the Repository

```bash
git clone https://github.com/sivanishanthar/ai-task-assistant.git
cd ai-task-assistant
```

### 2. Install Dependencies

```bash
npm ci
```

### 3. Set Up Your API Key

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` and add your OpenAI API key:

```env
OPENAI_API_KEY=your_actual_api_key
```

Make sure you don't commit your API key to GitHub. The `.env` file is already included in `.gitignore`.

### 4. Run the Assistant

```bash
npm start
```

Once the assistant starts, you can enter requests directly in the terminal.

Type `exit` when you're finished.

## Example Requests

Here are a few things you can ask the assistant to do:

```text
Create a folder called Reports

Create a file called notes.txt

Write "My first AI agent project" into notes.txt

Read notes.txt

Show me all the files and folders in the workspace
```

The assistant uses the available tools to complete these tasks.

## Automated Testing

Since my background is in QA automation, I wanted automated testing to be part of the project from the beginning rather than something added at the end.

I used the built-in Node.js Test Runner to test each of the five tools.

The test cases cover both successful operations and error scenarios, including invalid filenames, duplicate file creation, attempts to overwrite existing content, missing files, and file-size restrictions.

### Run the Tests

```bash
npm test
```

To run the tests with code coverage:

```bash
node --test --experimental-test-coverage tests/*.test.js
```

### Write Safety

`writeFile(fileName, content, workspace?)` now creates files only. Existing empty
files are rejected too: use `write_file` directly to create a file with content,
instead of creating an empty file first. The arguments and success response are
unchanged.

The writer runs in an isolated Node child process, selects each directory
relative to its pinned working directory, and checks directory identity after
selection. Symbolic links anywhere in the workspace path are rejected. On macOS,
use physical paths such as `/private/tmp` rather than the `/tmp` symlink when
supplying a custom workspace. The final workspace must belong to the current
user and must not be writable by group or others. Newly created directories use
mode `0700` and output files use mode `0600` (subject to the process umask).

Content is written in a private staging directory, then published using an atomic
hard link that fails if the destination already exists. Existing files, hard
links, symbolic links, and directories are never opened for writing. Staging is
cleaned on ordinary success and failure. An abrupt process or machine termination
may leave a `.ai-write-*` staging directory; no incomplete destination is
published. This is atomic publication, not a crash-durability guarantee.

This implementation supports macOS and Linux on filesystems supporting hard
links. Windows and filesystems that cannot perform the required operations fail
closed. The child process adds startup overhead per write and requires Node child
process execution to be permitted. This is not an isolation boundary against a
malicious process running as the same OS user, which can access the agent's files
and private staging directories. Other file tools retain their separate behavior
and have not received this hardening.

### Test Isolation

One improvement I made during development was separating the test environment from the application's actual workspace.

Each test now creates its own temporary directory using `fs.mkdtemp()`. Once the test finishes, that directory is removed.

This means tests can create, read, and delete files without affecting the files created by the AI assistant.

## CI/CD with GitHub Actions

I also set up a GitHub Actions workflow to automatically run the tests whenever I push changes to the `main` branch or create a pull request targeting it.

The pipeline:

1. Checks out the latest code.
2. Sets up Node.js 22.
3. Installs dependencies using `npm ci`.
4. Runs all automated tests.
5. Generates a code coverage report.

This helps me catch issues early and confirm that changes work in a clean environment, not just on my local machine.

You can see the latest results here:

[View GitHub Actions](https://github.com/sivanishanthar/ai-task-assistant/actions)

## A Few Things I've Focused On

While building this project, I tried to keep the tools simple and predictable.

For example, the assistant checks filenames before using them and rejects writes to all existing files, including empty files. The file-reading tool also checks that the requested path is a regular file and rejects files over 100 KB.

These checks reduce the risk of unexpected file operations, although the project is still a learning application and hasn't been security-audited. Some filesystem operations can also be affected by race conditions.

## What I've Learned

This project has helped me better understand:

- How OpenAI function calling works in a real Node.js application.
- How to connect AI-generated tool requests to JavaScript functions.
- How to structure an application into smaller, reusable modules.
- How to validate inputs and handle errors.
- How to write and organize automated unit tests.
- Why test isolation matters.
- How to measure code coverage.
- How to use GitHub Actions to run tests automatically.

It has also been a useful way to combine my QA automation experience with AI development.

## What's Next?

There are a few areas I'd like to explore as I continue improving the project:

- Add more tests for error-handling scenarios.
- Improve filesystem safety and error handling.
- Add additional tools to make the assistant more useful.
- Introduce logging to make troubleshooting easier.
- Add automated tests for the agent's tool-calling logic.
- Explore storing conversation history between sessions.

For now, the focus is on keeping the assistant simple, reliable, and easy to extend.

## About This Project

I built AI Task Assistant as a personal learning project to explore AI agents while applying software testing and automation practices.

The source code is available here:

[GitHub — AI Task Assistant](https://github.com/sivanishanthar/ai-task-assistant)

**Developed by [Siva Ramachandran](https://github.com/sivanishanthar)**