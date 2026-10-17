import { readSourceCoverage } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useShareContext } from '~/Providers/ShareContext';
import useLocalize from '~/hooks/useLocalize';

/** A preparation receipt for this answer's retained sources, never a reading claim. */
export default function SourceCoverage({
  message,
}: {
  message?: TMessage & { isEdited?: boolean };
}) {
  const localize = useLocalize();
  const { isSharedConvo, shareId } = useShareContext();
  if (
    !message ||
    message.isCreatedByUser !== false ||
    message.isUserSubmitted === true ||
    message.isEdited === true ||
    message.sourceContentRemovedAt != null ||
    isSharedConvo ||
    shareId
  ) {
    return null;
  }
  const receipt = readSourceCoverage(message.metadata?.sourceCoverage);
  if (!receipt || receipt.entries.length === 0) return null;

  return (
    <details
      key={message.messageId}
      className="text-text-secondary w-full min-w-0 rounded-lg text-sm"
    >
      <summary className="focus-visible:ring-text-primary cursor-pointer rounded px-1 py-1 focus-visible:ring-2 focus-visible:outline-none">
        {localize('com_ui_source_coverage_title')}
      </summary>
      <div className="mt-2 space-y-2 px-1 break-words">
        <p>{localize('com_ui_source_coverage_scope')}</p>
        <ul className="space-y-1">
          {receipt.entries.map((entry, index) => {
            const percent = entry.coverage.complete
              ? 100
              : Math.min(99, Math.floor((entry.coverage.end / entry.coverage.total) * 100));
            return (
              <li key={JSON.stringify([entry.source.kind, entry.source.id, entry.file_id])}>
                <span className="font-medium">
                  {localize('com_ui_source_coverage_source', { index: index + 1 })}
                </span>{' '}
                {localize(
                  entry.coverage.complete
                    ? 'com_ui_source_coverage_complete'
                    : 'com_ui_source_coverage_partial',
                  { percent: percent === 0 && entry.coverage.end > 0 ? '<1' : percent },
                )}
              </li>
            );
          })}
        </ul>
        <p>{localize('com_ui_source_coverage_limits')}</p>
      </div>
    </details>
  );
}
