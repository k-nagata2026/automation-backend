export default function Page() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>automation-backend</h1>
      <h2>nippo</h2>
      <p>Slack message shortcut → Backlog daily report comment.</p>
      <p>
        Endpoint: <code>POST /api/nippo/slack-to-backlog</code>
      </p>
    </main>
  );
}
