export interface BlockControlsProps {
  readonly blockId: string;
  readonly blockTitle: string;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly isLive: boolean;
  readonly canRevert: boolean;
  readonly disabled?: boolean;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onRemove: () => void;
  readonly onRefresh: () => void;
  readonly onRevert: () => void;
}

export default function BlockControls({
  blockId,
  blockTitle,
  isFirst,
  isLast,
  isLive,
  canRevert,
  disabled = false,
  onMoveUp,
  onMoveDown,
  onRemove,
  onRefresh,
  onRevert,
}: BlockControlsProps) {
  const button = (
    label: string,
    action: () => void,
    isDisabled: boolean,
    testId: string,
    tone: "default" | "danger" = "default",
  ) => (
    <button
      type="button"
      className={`report-control-button${tone === "danger" ? " danger" : ""}`}
      aria-label={`${label}: ${blockTitle}`}
      data-testid={`${testId}-${blockId}`}
      disabled={disabled || isDisabled}
      onClick={action}
    >
      {label}
    </button>
  );

  return (
    <div
      className="report-block-controls"
      role="toolbar"
      aria-label={`Block controls: ${blockTitle}`}
      data-testid={`block-controls-${blockId}`}
    >
      {button("Move up", onMoveUp, isFirst, "block-move-up")}
      {button("Move down", onMoveDown, isLast, "block-move-down")}
      {isLive
        ? button("Refresh data", onRefresh, false, "block-refresh")
        : null}
      {canRevert && !isLive
        ? button("Revert to live data", onRevert, false, "block-revert")
        : null}
      {button("Remove", onRemove, false, "block-remove", "danger")}
    </div>
  );
}
