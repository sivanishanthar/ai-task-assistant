// Offline CLI test doubles. No installed SDK, dotenv file, or real API is used.
const doubles = {
  openai: `
    export default class OpenAI {
      constructor() {
        if (process.env.LOG_TEST_MODE === 'constructor') throw new Error(process.env.LOG_TEST_PRIVATE_ERROR);
        let calls = 0;
        this.chat = { completions: { create: async () => {
          if (process.env.LOG_TEST_MODE === 'request_timeout') {
            const error = new Error(process.env.LOG_TEST_PRIVATE_ERROR);
            error.name = 'APIConnectionTimeoutError';
            throw error;
          }
          if (process.env.LOG_TEST_MODE === 'request') {
            throw new Error(process.env.LOG_TEST_PRIVATE_ERROR);
          }
          const message = calls++ === 0
            ? { role: 'assistant', content: null, tool_calls: [{
                id: 'private-call-id', type: 'function', function: { name: 'read_file',
                  arguments: JSON.stringify({fileName: process.env.LOG_TEST_FILENAME}) }
              }] }
            : { role: 'assistant', content: 'Read completed.' };
          return { choices: [{ message }] };
        } } };
      }
    }
  `,
  dotenv: `export default { config() {} };`,
  'node:readline/promises': `
    export default { createInterface() {
      let questions = 0;
      return {
        async question() {
          if (process.env.LOG_TEST_MODE === 'fatal') throw new Error(process.env.LOG_TEST_PRIVATE_ERROR);
          return questions++ === 0 ? process.env.LOG_TEST_PROMPT : 'exit';
        },
        close() {}
      };
    } };
  `,
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(doubles, specifier)) {
    return { url: 'data:text/javascript,' + encodeURIComponent(doubles[specifier]), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
