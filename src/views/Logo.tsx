export default function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10.6" stroke="#1c1e21" strokeWidth="1.6" />
      <path
        d="M5.5 15.5C8 12.5 15 7 18.6 6.8"
        stroke="#1c1e21"
        strokeWidth="1.1"
        opacity="0.45"
      />
      <circle cx="7.4" cy="13.8" r="2" fill="#e5484d" />
      <circle cx="12.4" cy="10" r="2" fill="#edb200" />
      <circle cx="16.8" cy="7.6" r="2" fill="#2f9e44" />
    </svg>
  );
}
