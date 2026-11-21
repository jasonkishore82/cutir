import DeliverPanel from "./DeliverPanel";

/** The Deliver page: the preset picker and the render queue, full size, instead of a dialog. */
export default function DeliverPage() {
  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-[720px] space-y-3">
        <h2 className="text-sm font-semibold text-gray-100">Deliver</h2>
        <p className="text-xs text-gray-500">Pick a preset, choose what to render, and add it to the queue. Jobs keep running while you switch pages.</p>
        <DeliverPanel />
      </div>
    </div>
  );
}
