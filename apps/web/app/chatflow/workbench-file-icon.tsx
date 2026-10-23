/** Pinned DSH has no upload or bookmark artwork; keep these file-action gaps here. */
export function WorkbenchFileIcon({ kind }: { kind: 'upload' | 'reference' }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'upload' ? (
        <>
          <path d="M12 16V3m-5 5 5-5 5 5" vectorEffect="non-scaling-stroke" />
          <path
            d="M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : (
        <>
          <path
            d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"
            vectorEffect="non-scaling-stroke"
          />
          <path d="M12 7v6m-3-3h6" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}
