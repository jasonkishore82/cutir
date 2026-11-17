/** Phase 1 placeholder. Ollama chat and tool calls arrive in Phase 4. */
export default function ChatPanel() {
  return (
    <div className="h-full flex flex-col">
      <div className="p-3 border-b border-edge text-sm font-semibold">AI Chat</div>
      <div className="flex-1 p-3 text-xs text-gray-500">
        Connects to a local Ollama server in Phase 4.
      </div>
    </div>
  );
}
