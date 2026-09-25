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
  const controlStyle: Record<string, string> = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    color: "var(--text)",
  };
  const button = (
    label: string,
    action: () => void,
    isDisabled: boolean,
    testId: string,
  ) => (
    <button
      type="button"
      aria-label={`${label}: ${blockTitle}`}
      data-testid={`${testId}-${blockId}`}
      disabled={disabled || isDisabled}
      onClick={action}
      style={controlStyle}
    >
      {label}
    </button>
  );

  return (
    <div
      role="toolbar"
      aria-label={`Block controls: ${blockTitle}`}
      data-testid={`block-controls-${blockId}`}
      style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}
    >
      {button("Move up", onMoveUp, isFirst, "block-move-up")}
      {button("Move down", onMoveDown, isLast, "block-move-down")}
      {button("Remove", onRemove, false, "block-remove")}
      {isLive
        ? button("Refresh data", onRefresh, false, "block-refresh")
        : null}
      {canRevert && !isLive
        ? button("Revert to live data", onRevert, false, "block-revert")
        : null}
    </div>
  );
}
