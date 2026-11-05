// Offline CLI test doubles. No installed SDK, dotenv file, or real API is used.
const doubles = {
  openai: `
    import { writeFileSync } from 'node:fs';
    export default class OpenAI {
      constructor() {
        if (process.env.LOG_TEST_MODE === 'constructor') throw new Error(process.env.LOG_TEST_PRIVATE_ERROR);
        let calls = 0;
        const requests = [];
        if (process.env.HELP_TEST_TRACE) {
          process.on('exit', () => writeFileSync(process.env.HELP_TEST_TRACE, JSON.stringify({ calls, requests })));
        }
        this.chat = { completions: { create: async request => {
          if (process.env.HELP_TEST_TRACE) {
            calls++;
            requests.push(structuredClone(request));
            if (process.env.HELP_TEST_FAIL_API === '1') throw new Error('Unexpected API call during local help');
            return { choices: [{ message: { role: 'assistant', content: 'Mock reply.' } }] };
          }
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
          if (process.env.HELP_TEST_INPUTS) return JSON.parse(process.env.HELP_TEST_INPUTS)[questions++] ?? 'exit';
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
