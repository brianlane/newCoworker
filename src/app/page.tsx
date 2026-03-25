import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "2rem" }}>
      <h1>New Coworker: Organic Intelligence</h1>
      <p>
        Full-system monorepo for dashboard, provisioning, OpenClaw configuration,
        and voice integrations.
      </p>
      <div style={{ display: "flex", gap: "1rem" }}>
        <Link href="/dashboard">Owner Dashboard</Link>
        <Link href="/admin">Agency Admin</Link>
      </div>
    </main>
  );
}
