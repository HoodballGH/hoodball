export default function Eth({ size = "1em" }: { size?: string }) {
  return (
    <svg
      className="eth"
      width={size}
      height={size}
      viewBox="0 0 256 417"
      aria-label="ETH"
      role="img"
      style={{ display: "inline-block", verticalAlign: "-0.12em", marginLeft: "0.2em" }}
    >
      <path fill="currentColor" fillOpacity="0.6" d="M127.9 0L125.2 9.5v275.7l2.7 2.8 127.9-75.6z" />
      <path fill="currentColor" d="M127.9 0L0 212.4l127.9 75.6V154.2z" />
      <path fill="currentColor" fillOpacity="0.6" d="M127.9 312.2l-1.6 1.9v98.2l1.6 4.6 128-180.3z" />
      <path fill="currentColor" d="M127.9 416.9V312.2L0 236.6z" />
      <path fill="currentColor" fillOpacity="0.2" d="M127.9 288l127.9-75.6-127.9-58.2z" />
      <path fill="currentColor" fillOpacity="0.6" d="M0 212.4L127.9 288V154.2z" />
    </svg>
  );
}
