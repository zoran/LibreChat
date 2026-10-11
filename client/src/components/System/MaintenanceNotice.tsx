/** The public entry enforces maintenance; this modal locks already-open application pages. */
import { useEffect, useRef, useState } from 'react';
import { Wrench } from 'lucide-react';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function MaintenanceNotice() {
  const { data: config } = useGetStartupConfig();
  const localize = useLocalize();
  const [active, setActive] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Startup config itself can be blocked when maintenance starts during page loading.
  const enabled = config?.maintenanceStatusEnabled !== false || active;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let pending: AbortController | undefined;
    const check = async () => {
      if (disposed || pending) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch('/maintenance/status', {
          cache: 'no-store',
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok || response.redirected) return;
        const status: unknown = await response.json();
        if (
          !disposed &&
          status != null &&
          typeof status === 'object' &&
          'version' in status &&
          status.version === 1 &&
          'active' in status &&
          typeof status.active === 'boolean'
        ) {
          setActive(status.active);
        }
      } catch {
        // A lost connection never clears an observed maintenance lock.
      } finally {
        window.clearTimeout(timeout);
        pending = undefined;
      }
    };
    const visible = () => {
      if (!document.hidden) void check();
    };
    void check();
    const interval = window.setInterval(() => void check(), 5000);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
      pending?.abort();
    };
  }, [enabled]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (active && !element.open) {
      element.showModal();
      heading.current?.focus();
    } else if (!active && element.open) {
      element.close();
    }
  }, [active]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="maintenance-title"
      aria-describedby="maintenance-message maintenance-recovery"
      aria-modal="true"
      onCancel={(event) => event.preventDefault()}
      onKeyDownCapture={(event) => event.stopPropagation()}
      className="bg-surface-primary text-text-primary fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 p-6 backdrop:bg-black/70"
    >
      <div className="flex min-h-full items-center justify-center">
        <div className="max-w-lg text-center">
          <Wrench aria-hidden="true" className="text-text-secondary mx-auto mb-6 h-10 w-10" />
          <h1
            ref={heading}
            id="maintenance-title"
            tabIndex={-1}
            className="mb-4 text-2xl font-semibold outline-none"
          >
            {localize('com_maintenance_title')}
          </h1>
          <p id="maintenance-message" className="text-base leading-7">
            {localize('com_maintenance_message')}
          </p>
          <p
            id="maintenance-recovery"
            role="status"
            className="text-text-secondary mt-5 text-sm leading-6"
          >
            {localize('com_maintenance_recovery')}
          </p>
        </div>
      </div>
    </dialog>
  );
}
