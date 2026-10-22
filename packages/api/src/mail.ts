/** Inert mail composition. Only an explicit send acquires a transport/socket. */
export { createOutboundMailAdapter } from './mail/mime';
export type { OutboundMailAdapterDependencies } from './mail/mime';
export { composeRetentionMailSender } from './files/retentionMailComposition';
export type { RetentionMailRuntime } from './files/retentionMailComposition';
export type {
  RetentionMailSender,
  RetentionMailInput,
  RetentionMailOutcome,
} from './files/retentionMailSender';
export type { MailDependencies, MailMessage } from './mail/submission';
