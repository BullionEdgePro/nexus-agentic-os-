import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | Nexus Agentic OS",
  description: "Terms of Service for the Nexus Agentic OS WhatsApp automation platform.",
};

export default function TermsOfServicePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-neutral-200">
      <h1 className="text-2xl font-semibold text-white">Terms of Service</h1>
      <p className="mt-2 text-sm text-neutral-400">Last updated: 4 September 2026</p>

      <p className="mt-6 leading-relaxed">
        Nexus Agentic OS (&quot;Nexus&quot;, &quot;we&quot;, &quot;us&quot;) provides AI-assisted
        WhatsApp Business messaging on behalf of the businesses it serves, including Zipicka,
        Juris Prime, Juris Prime Legal, SFS International, and ABR Advocates &amp; Legal Consultants.
        By using Nexus — whether as a staff member of one of these businesses or as a customer who
        messages one of them on WhatsApp — you agree to these terms.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">The service</h2>
      <p className="mt-3 leading-relaxed">
        Nexus receives messages through Meta&apos;s WhatsApp Business Platform and helps the
        business you contacted answer them, drafting replies with an AI model and routing
        conversations to the right staff member. A business&apos;s staff can connect their own
        WhatsApp Business number so that messages to it appear in their Nexus dashboard alongside
        the business&apos;s shared line.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Acceptable use</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed">
        <li>Use Nexus only for lawful business communication with your own customers.</li>
        <li>Do not send spam, unsolicited bulk messages, or content that violates WhatsApp&apos;s
          Business Messaging Policy or Meta&apos;s Commerce and Business policies.</li>
        <li>Do not attempt to access another business&apos;s conversations, staff accounts, or data.</li>
        <li>Connect only a WhatsApp number you control and are authorised to use for the business.</li>
      </ul>

      <h2 className="mt-8 text-lg font-medium text-white">Staff accounts and connected numbers</h2>
      <p className="mt-3 leading-relaxed">
        Staff are responsible for keeping their access credentials secure and for the messages
        they send. A connected WhatsApp Business number remains owned by the staff member or their
        business; it can be disconnected at any time from the Connections screen, which unlinks it
        from Nexus.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">AI-assisted replies</h2>
      <p className="mt-3 leading-relaxed">
        Replies may be drafted by an automated AI model and are checked before sending, but they
        can contain errors. The business remains responsible for its communications. A human staff
        member can take over any conversation at any time.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Availability and changes</h2>
      <p className="mt-3 leading-relaxed">
        We provide the service on an &quot;as is&quot; basis and may change, suspend, or discontinue
        parts of it. We may update these terms; continued use after a change means you accept the
        updated terms.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Data and privacy</h2>
      <p className="mt-3 leading-relaxed">
        Your use of Nexus is also governed by our{" "}
        <a className="text-emerald-400 underline" href="/privacy">Privacy Policy</a>. To request
        deletion of your data, see our{" "}
        <a className="text-emerald-400 underline" href="/data-deletion">Data Deletion instructions</a>.
      </p>

      <h2 className="mt-8 text-lg font-medium text-white">Contact</h2>
      <p className="mt-3 leading-relaxed">
        For any questions about these terms, contact{" "}
        <a className="text-emerald-400 underline" href="mailto:jurishostinger11@gmail.com">
          jurishostinger11@gmail.com
        </a>
        .
      </p>
    </main>
  );
}
