/* global process */
import {
  readNativeSubagentSummary,
  withNativeQueryReader,
} from '../../dsh/allrice-native-query.mjs';
const result = await withNativeQueryReader(process.argv[2], (ctx) => {
  if (ctx.get('agents') || ctx.get('llm') || ctx.sessions.list().length)
    throw Error('Reader unexpectedly has execution services');
  return readNativeSubagentSummary(ctx, process.argv[3]);
});
process.stdout.write(JSON.stringify(result));
