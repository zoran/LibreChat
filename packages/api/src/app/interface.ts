import { presentationSchema } from 'librechat-data-provider';
import type { TInterfaceConfig } from 'librechat-data-provider';

type PreLoginInterface = Pick<
  TInterfaceConfig,
  'privacyPolicy' | 'termsOfService' | 'buildInfo' | 'theme' | 'appLogo'
>;

/**
 * Selects the interface fields a signed-out client may see: the legal links the
 * login page renders, the public app logo, a disabled build-info flag, and the theme so the
 * login page paints it instead of switching after sign-in. Returns `undefined`
 * when none of them is configured, so the payload omits `interface` entirely.
 */
export function buildPreLoginInterface(
  interfaceConfig?: Partial<TInterfaceConfig>,
): PreLoginInterface | undefined {
  if (!interfaceConfig) {
    return undefined;
  }
  const { privacyPolicy, termsOfService, buildInfo, theme } = interfaceConfig;
  const parsedLogo = presentationSchema.shape.appLogo.safeParse(interfaceConfig.appLogo);
  const appLogo = parsedLogo.success ? parsedLogo.data : undefined;
  const selected: PreLoginInterface = {
    ...(appLogo && { appLogo }),
    ...(privacyPolicy && { privacyPolicy }),
    ...(termsOfService && { termsOfService }),
    ...(buildInfo === false && { buildInfo }),
    ...(theme && { theme }),
  };
  return Object.keys(selected).length > 0 ? selected : undefined;
}
