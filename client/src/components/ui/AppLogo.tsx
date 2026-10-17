import { useTheme } from '@librechat/client';
import type { TStartupConfig } from 'librechat-data-provider';
import { getAppTitle } from '~/utils/presentation';
import cn from '~/utils/cn';

/** Deployment identity, independent of model/provider identity and OS theme preference. */
export default function AppLogo({
  startupConfig,
  variant = 'wordmark',
  fallbackSrc,
  className,
}: {
  startupConfig?: {
    appTitle?: TStartupConfig['appTitle'];
    interface?: Pick<NonNullable<TStartupConfig['interface']>, 'appLogo'>;
  } | null;
  variant?: 'wordmark' | 'mark';
  fallbackSrc?: string;
  className?: string;
}) {
  const { resolvedMode } = useTheme();
  const logo = startupConfig?.interface?.appLogo;
  const dark = resolvedMode === 'dark';
  const wordmark = dark ? (logo?.dark ?? logo?.light) : logo?.light;
  const mark = dark ? (logo?.markDark ?? logo?.mark) : logo?.mark;
  const src = (variant === 'mark' ? (mark ?? wordmark) : wordmark) ?? fallbackSrc;

  return src ? (
    <img
      src={src}
      alt={getAppTitle(startupConfig?.appTitle)}
      className={cn(
        'w-auto max-w-full shrink-0 object-contain',
        wordmark ? 'h-16 sm:h-20' : 'h-10',
        className,
      )}
    />
  ) : null;
}
