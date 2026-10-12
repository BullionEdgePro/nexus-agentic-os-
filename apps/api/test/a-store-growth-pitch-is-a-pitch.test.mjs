// A store-growth pitch is a pitch; a customer is a customer (audit, 12 Oct 2026).
//
// Since 30 Sep every email from a person reaches the inbox. Zipicka's mailbox
// then filled with the Shopify-agency cold pitch — "I noticed 2 things you could
// fix", "20-40 extra sales, no upfront", "free AI video sample", "scale to $35K
// before Black Friday" — and every one stood as an URGENT "customer waiting"
// finding. The pitch rule knew the WhatsApp pitch ("we are a", "we offer") and
// none of this. Mixed in among them were REAL customers left waiting for days: an
// order cancellation, a wholesale enquiry, a shipping question.
//
// Every message below is real (12 Oct 2026, trimmed). The rule must catch every
// pitch and must not catch a single customer — a customer judged a salesman is
// hidden from the one signal meant to find them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreLead } from "@nexus/leads";

const PITCHES = [
  "Hey, just checked your store. Love the brand. Quick one: are you getting organic traffic from Google yet or mostly ads? I noticed 2 things you could fix to get more sales. Want me to send them?",
  "Hi Zipicka, I love what you’ve built with your store! With 86 days left, Black Friday and Christmas are approaching fast. I see products with the potential to scale from $0- $35K across the US and UK market through organic growth only, without social or meta ads.",
  "Hallo Zipicka, ich bin Abama Godwin. Ich würde Zipicka gerne dabei helfen, im Oktober und November 20–40 zusätzliche Verkäufe durch Conversion-Optimierung, KI-Sichtbarkeit und TikTok Shop zu erzielen. Keine Vorauszahlung.",
  "Hey! Zipicka Your products caught my attention, and I think they’d look great as AI videos. Want me to create a quick free sample for you?",
  "Dear Admin, A checkout configuration issue has been identified that continues to interfere with payment processing and successful order completion. To address this, we will connect you with a live technical consultant through our partner network.",
  "Am I in contact with the shop owner?",
];

const CUSTOMERS = [
  "Hi, I would like to cancel my order #AWDLFJ3CN. It is a Cash on Delivery order. Please confirm the cancellation. Thank you.",
  "Do you supply in large quantities?",
  "Did you see my message",
  "Hi there, Do you offer shipping to the UAE? Appreciate any details. Brittany",
  "Greetings, can I purchase one from US?",
  "HOLA Zipicka, is your product suitable for birthday gift!!!",
  "Is your store open on Friday? I want to pick up my order.",
];

test("every store-growth pitch is recognised as a pitch", () => {
  for (const text of PITCHES) {
    assert.equal(scoreLead({ text }).category, "inbound_pitch", `not caught: ${text.slice(0, 60)}`);
  }
});

test("no real customer is mistaken for a pitch", () => {
  for (const text of CUSTOMERS) {
    assert.notEqual(scoreLead({ text }).category, "inbound_pitch", `customer hidden: ${text.slice(0, 60)}`);
  }
});
