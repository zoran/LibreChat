import type { Model } from 'mongoose';
import type { EmailCodeBudget, EmailCodeChallenge } from '~/types/emailCode';
import { emailCodeChallengeSchema, emailCodeBudgetSchema } from '~/schema/emailCode';

/** Explicit tenant predicates belong to the auth repository; global budgets have no employee tenant. */
export function createEmailCodeModels(mongoose: typeof import('mongoose')): {
  EmailCodeChallenge: Model<EmailCodeChallenge>;
  EmailCodeBudget: Model<EmailCodeBudget>;
} {
  return {
    EmailCodeChallenge:
      mongoose.models.EmailCodeChallenge ??
      mongoose.model<EmailCodeChallenge>('EmailCodeChallenge', emailCodeChallengeSchema),
    EmailCodeBudget:
      mongoose.models.EmailCodeBudget ??
      mongoose.model<EmailCodeBudget>('EmailCodeBudget', emailCodeBudgetSchema),
  };
}
