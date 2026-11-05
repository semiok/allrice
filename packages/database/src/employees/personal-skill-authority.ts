import { enterMethodChat } from './employee-method-chat.ts';
import { assertPersonalSkillInstanceAllowed } from './employee-instance-policy.ts';

/** Keep the existing human-source, lease and assignment gates. The product
 * boundary runs before package IO, replay receipts and binding mutations. */
export const enterPersonalSkillChat: typeof enterMethodChat = (
  input,
  tool,
  retire,
  read,
  options,
) =>
  enterMethodChat(
    input,
    tool,
    retire,
    async (tx, instance, text) => {
      await assertPersonalSkillInstanceAllowed(instance, tx);
      return read(tx, instance, text);
    },
    options,
  );
