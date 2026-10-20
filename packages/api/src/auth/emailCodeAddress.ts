import { z } from 'zod';

/** Shared mailbox canonicalization for email-code identity and server policy. */
export const emailCodeAddressSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .transform((email) => email.toLowerCase());
