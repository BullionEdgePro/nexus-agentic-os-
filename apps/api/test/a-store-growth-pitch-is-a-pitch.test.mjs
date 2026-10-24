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
  // Verbatim from the business mailbox, 24 Oct 2026 — each listed by Staff work
  // as a "customer waiting" for weeks.
  "Ur shp ON?",
  "Hey Zipicka, If I generate consistent orders, would you work with me?",
  "Can I share a collaboration idea with you?",
  "Hello, May I share something important with you through this email? Before I proceed, could you please confirm whether this email address is active and monitored for further discussion? Thank you for your time. I look forward to your confirmation. Kind regards,",
  "Hello Marketing, I’ve identified a potential opportunity that could help generate an additional $10K–$15K in revenue for your store. Would you be open to a quick conversation so I can show you the strategy and how I’d approach it, let's talk about it on WhatsApp.",
  "𝑯𝒊 Marketing, 𝑾𝒐𝒖𝒍𝒅 𝒚𝒐𝒖 𝒃𝒆 𝒐𝒑𝒆𝒏 𝒕𝒐 𝒆𝒙𝒑𝒍𝒐𝒓𝒊𝒏𝒈 𝒂𝒏 𝒐𝒑𝒑𝒐𝒓𝒕𝒖𝒏𝒊𝒕𝒚 𝒇𝒐𝒓 𝒎𝒖𝒕𝒖𝒂𝒍 𝒃𝒖𝒔𝒊𝒏𝒆𝒔𝒔 𝒈𝒓𝒐𝒘𝒕𝒉?",
  "Hello Zipicka, Have you ever wondered why people visit your store, view your products, or even add them to cart—but still don't buy? It may have less to do with your products",
  "𝐈 𝐜𝐚𝐧 𝐡𝐞𝐥𝐩 𝐲𝐨𝐮 𝐚𝐭𝐭𝐫𝐚𝐜𝐭 𝟒𝟎–𝟓𝟎 𝐩𝐨𝐭𝐞𝐧𝐭𝐢𝐚𝐥 𝐛𝐮𝐲𝐞𝐫𝐬 and recover 76 abandoned carts, leading to",
  "Hello Zipicka owner, I added my pet needs to cart on Zipicka and left. No recovery email came in 24 hours (I checked spam too). Pet owners often pause over si",
  "Hi Zipicka team, I noticed Zipicka has a WhatsApp chat button on the store and offers COD, Tabby and Tamara at checkout - it looks like WhatsApp is a big part",
  "Hi marketing, I came across your Shopify store and spotted a potential customer-acquisition opportunity. My approach would be to identify your strongest product, create UGC-style content that builds buying interest, target people who genuinely need it, and then use retargeting + email follow-ups to",
];

const CUSTOMERS = [
  "Hi, I would like to cancel my order #AWDLFJ3CN. It is a Cash on Delivery order. Please confirm the cancellation. Thank you.",
  "Do you supply in large quantities?",
  "Did you see my message",
  "Hi there, Do you offer shipping to the UAE? Appreciate any details. Brittany",
  "Greetings, can I purchase one from US?",
  "HOLA Zipicka, is your product suitable for birthday gift!!!",
  "Is your store open on Friday? I want to pick up my order.",
  // Customers who share words with the pitches above, so the new phrases are
  // proven not to swallow them.
  "Can I share a photo of the item I received? It arrived damaged.",
  "Please confirm my email address is correct for the invoice.",
  "I came across your product on Instagram, is it still available?",
  "Is your shop open today?",
  "I want to order 3 more for my family, can you deliver to Sharjah?",
  "I added two items to my cart but the checkout keeps failing, can you help?",
  "Do you accept Tabby at checkout?",
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
