import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | Nexus Agentic OS",
  description: "Privacy policy for the Nexus Agentic OS WhatsApp automation platform.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-neutral-200">
      <h1 className="text-2xl font-semibold text-white">Privacy Policy</h1>
      <p className="mt-2 text-sm text-neutral-400">Last updated: 29 July 2026</p>

      <p className="mt-6 leading-relaxed">
        Nexus Agentic OS (&quot;Nexus&quot;, &quot;we&quot;, &quot;us&quot;) provides AI-assisted
        WhatsApp Business messaging on behalf of the businesses it serves, including Zipicka,
        Juris Prime, Juris Prime Legal, SFS International, and ABR Advocates & Legal Consultants. This policy
        explains what information we process when you message one of these businesses on
        WhatsApp and how it is handled.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Information we process</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed">
        <li>Your WhatsApp phone number and profile name, as provided by WhatsApp.</li>
        <li>The content of messages you send to and receive from the business.</li>
        <li>Message timestamps and delivery status.</li>
      </ul>

      <h2 className="mt-8 text-lg font-medium text-white">How we use it</h2>
      <p className="mt-3 leading-relaxed">
        Messages are received through Meta&apos;s WhatsApp Business Platform and processed by our
        systems to generate and send replies on behalf of the business you contacted. Message
        content may be sent to Anthropic&apos;s Claude AI model to draft a response. Every
        AI-drafted reply passes through automated checks before sending, and can be paused for a
        human staff member to review and respond instead.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Data sharing</h2>
      <p className="mt-3 leading-relaxed">
        We share message content with Meta Platforms, Inc. (as the WhatsApp Business Platform
        provider) and Anthropic, PBC (as our AI processing provider) solely to deliver this
        service. We do not sell your data or share it with any other third party.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Data retention</h2>
      <p className="mt-3 leading-relaxed">
        Conversation history is retained for as long as needed to provide support and maintain
        service quality, and may be deleted or anonymized on request.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Your rights</h2>
      <p className="mt-3 leading-relaxed">
        You can request access to, correction of, or deletion of your data at any time by
        contacting us using the details below, or by messaging &quot;stop&quot; to opt out of
        further automated messages.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Contact</h2>
      <p className="mt-3 leading-relaxed">
        For any privacy questions or requests, contact{" "}
        <a className="text-emerald-400 underline" href="mailto:jurishostinger11@gmail.com">
          jurishostinger11@gmail.com
        </a>
        .
      </p>
    </main>
  );
}
