/** UploadAvailabilityHint keeps a disabled upload reachable by keyboard, pointer and touch. */
import React from 'react';
import * as Ariakit from '@ariakit/react';

/** The wrapper explains a native-disabled action; it never activates the hidden file input. */
export function UploadAvailabilityHint({
  label,
  reason,
  children,
}: {
  label: string;
  reason: string | null;
  children: React.ReactNode;
}) {
  const tooltip = Ariakit.useTooltipStore({ placement: 'top' });
  if (!reason) return <>{children}</>;
  return (
    <Ariakit.TooltipProvider store={tooltip}>
      <Ariakit.TooltipAnchor
        render={<span />}
        tabIndex={0}
        role="group"
        aria-label={label}
        className="focus-visible:ring-text-primary/50 inline-flex rounded-full focus-visible:ring-2 focus-visible:outline-hidden"
        onClick={() => (tooltip.getState().open ? tooltip.hide() : tooltip.show())}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            tooltip.show();
          } else if (event.key === 'Escape') {
            tooltip.hide();
          }
        }}
      >
        {children}
      </Ariakit.TooltipAnchor>
      <Ariakit.Tooltip
        gutter={4}
        className="border-border-light bg-surface-primary text-text-primary z-50 max-w-xs rounded-lg border px-3 py-2 text-sm shadow-lg"
      >
        <Ariakit.TooltipArrow />
        {reason}
      </Ariakit.Tooltip>
    </Ariakit.TooltipProvider>
  );
}
