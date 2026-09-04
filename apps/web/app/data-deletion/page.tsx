import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Data Deletion | Nexus Agentic OS",
  description: "How to request deletion of your data from the Nexus Agentic OS platform.",
};

export default function DataDeletionPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-neutral-200">
      <h1 className="text-2xl font-semibold text-white">Data Deletion Instructions</h1>
      <p className="mt-2 text-sm text-neutral-400">Last updated: 4 September 2026</p>

      <p className="mt-6 leading-relaxed">
        Nexus Agentic OS (&quot;Nexus&quot;, &quot;we&quot;, &quot;us&quot;) processes WhatsApp
        messages on behalf of the businesses it serves. You can ask us to delete the data we hold
        about you at any time, and this page explains how.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">What we hold</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed">
        <li>Your WhatsApp phone number and profile name.</li>
        <li>The content of messages you sent to and received from the business.</li>
        <li>Message timestamps and delivery status.</li>
      </ul>

      <h2 className="mt-8 text-lg font-medium text-white">How to request deletion</h2>
      <p className="mt-3 leading-relaxed">
        Email{" "}
        <a className="text-emerald-400 underline" href="mailto:jurishostinger11@gmail.com?subject=Data%20deletion%20request">
          jurishostinger11@gmail.com
        </a>{" "}
        from, or including, the WhatsApp number you used, with the subject &quot;Data deletion
        request&quot;. Tell us which business you were messaging if you know it. You can also send
        the word &quot;stop&quot; in the WhatsApp conversation to halt further automated messages.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">What happens next</h2>
      <p className="mt-3 leading-relaxed">
        We verify the request against the number provided and delete the associated contact record
        and conversation history from our systems, normally within 30 days. We will confirm by
        reply once it is done. Some records may be retained only where the law requires it.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Data held by Meta</h2>
      <p className="mt-3 leading-relaxed">
        Message delivery is handled by Meta&apos;s WhatsApp Business Platform. Data held by Meta is
        subject to Meta&apos;s own policies; deleting your data from Nexus does not delete it from
        Meta. See also our{" "}
        <a className="text-emerald-400 underline" href="/privacy">Privacy Policy</a>.
      </p>
    </main>
  );
}
