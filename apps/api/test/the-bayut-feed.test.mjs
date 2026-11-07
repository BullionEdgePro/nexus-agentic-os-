// The Bayut / dubizzle feed (7 Nov 2026): one XML document Bayut reads from a
// public address and publishes to Bayut and/or dubizzle. The tag names are
// provisional until Bayut's own XML document arrives (phase 2 aligns one map);
// what must hold already is that the document is well formed whatever staff
// type, and that each listing says which of the two portals it is for.
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §6
import { test } from "node:test";
import assert from "node:assert/strict";
import { bayutFeedXml, xmlText, cdata } from "@nexus/shared";

const AT = "2026-11-07T08:00:00.000Z";

const LISTING = {
  reference: "u-1",
  updatedAt: "2026-11-06T09:30:00.000Z",
  purpose: "rent",
  priceAed: 95000,
  propertyType: "apartment",
  bedrooms: 1,
  bathrooms: 2,
  sizeSqft: 812,
  furnishing: "unfurnished",
  title: "Bright 1-bed with canal view",
  description: "A bright one-bedroom apartment on a high floor.\nBalcony over the canal.",
  city: "Dubai",
  community: "Business Bay",
  subCommunity: "Bay Square",
  building: "Building 4",
  amenities: ["balcony", "central_ac"],
  parking: 1,
  availableFrom: "2026-12-01",
  permitNumber: "71450",
  permitExpiresOn: "2027-10-27",
  photoUrls: ["https://api.nexusagenticos.com/portal-photos/p1.jpg", "https://api.nexusagenticos.com/portal-photos/p2.jpg"],
  agent: { name: "Aisha Khan", email: "aisha@sfs.ae", phone: "971501112233", brn: "45678" },
  orn: "12345",
  portals: ["bayut", "dubizzle"],
};

/**
 * A small XML reader for the test: checks the document is well formed (every
 * tag closed in order, no stray < or &) and returns the elements as a tree
 * with their text (CDATA unwrapped, entities decoded).
 */
function parse(xml) {
  const decl = xml.match(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  assert.ok(decl, "starts with the XML declaration");
  let i = decl[0].length;
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  const decode = (s) => {
    assert.doesNotMatch(s, /&(?!(amp|lt|gt|quot|apos);)/, `bare & in ${JSON.stringify(s)}`);
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  };
  while (i < xml.length) {
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i);
      assert.ok(end > 0, "CDATA is closed");
      stack.at(-1).text += xml.slice(i + 9, end);
      i = end + 3;
    } else if (xml.startsWith("</", i)) {
      const end = xml.indexOf(">", i);
      const name = xml.slice(i + 2, end);
      const open = stack.pop();
      assert.equal(name, open.name, `</${name}> closes <${open.name}>`);
      i = end + 1;
    } else if (xml[i] === "<") {
      const end = xml.indexOf(">", i);
      const raw = xml.slice(i + 1, end);
      const selfClosing = raw.endsWith("/");
      const [name, ...rest] = raw.replace(/\/$/, "").split(/\s+/);
      assert.match(name, /^[A-Za-z_][\w.-]*$/, `tag name ${name}`);
      const attrs = Object.fromEntries([...rest.join(" ").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])]));
      const node = { name, attrs, children: [], text: "" };
      stack.at(-1).children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    } else {
      const next = xml.indexOf("<", i);
      const chunk = xml.slice(i, next < 0 ? undefined : next);
      assert.doesNotMatch(chunk, />/, "no stray >");
      stack.at(-1).text += decode(chunk);
      i = next < 0 ? xml.length : next;
    }
  }
  assert.equal(stack.length, 1, "every element is closed");
  assert.equal(root.children.length, 1, "one root element");
  return root.children[0];
}
const child = (node, name) => node.children.find((c) => c.name === name);
const textOf = (node, name) => child(node, name)?.text.trim();

test("text escapes and CDATA keep any characters", () => {
  assert.equal(xmlText(`a<b>&"c"'d`), "a&lt;b&gt;&amp;&quot;c&quot;&apos;d");
  assert.equal(cdata("plain"), "<![CDATA[plain]]>");
  assert.equal(cdata("x]]>y"), "<![CDATA[x]]]]><![CDATA[>y]]>");
});

test("no listings is still a well-formed, empty document", () => {
  const doc = parse(bayutFeedXml([], AT));
  assert.equal(doc.name, "Listings");
  assert.equal(doc.attrs.generated, AT);
  assert.equal(doc.children.length, 0);
});

test("a listing carries its details, photos, licences and portals", () => {
  const doc = parse(bayutFeedXml([LISTING], AT));
  assert.equal(doc.children.length, 1);
  const l = doc.children[0];
  assert.equal(l.name, "Listing");
  assert.equal(textOf(l, "Property_Ref_No"), "u-1");
  assert.equal(textOf(l, "Permit_Number"), "71450");
  assert.equal(textOf(l, "Property_purpose"), "Rent");
  assert.equal(textOf(l, "Property_Type"), "Apartment");
  assert.equal(textOf(l, "City"), "Dubai");
  assert.equal(textOf(l, "Locality"), "Business Bay");
  assert.equal(textOf(l, "Sub_Locality"), "Bay Square");
  assert.equal(textOf(l, "Tower_Name"), "Building 4");
  assert.equal(textOf(l, "Property_Title"), "Bright 1-bed with canal view");
  assert.equal(child(l, "Property_Description").text, LISTING.description);
  assert.equal(textOf(l, "Property_Size"), "812");
  assert.equal(textOf(l, "Property_Size_Unit"), "SQFT");
  assert.equal(textOf(l, "Bedrooms"), "1");
  assert.equal(textOf(l, "Bathroom"), "2");
  assert.equal(textOf(l, "Price"), "95000");
  assert.equal(textOf(l, "Rent_Frequency"), "Yearly");
  assert.equal(textOf(l, "Furnished"), "No");
  assert.deepEqual(child(l, "Features").children.map((f) => f.text), ["Balcony", "Central A/C"]);
  assert.deepEqual(child(l, "Images").children.map((f) => f.text), LISTING.photoUrls);
  assert.equal(textOf(l, "Listing_Agent"), "Aisha Khan");
  assert.equal(textOf(l, "Listing_Agent_Email"), "aisha@sfs.ae");
  assert.equal(textOf(l, "Listing_Agent_Phone"), "971501112233");
  assert.equal(textOf(l, "Listing_Agent_BRN"), "45678");
  assert.equal(textOf(l, "Agency_ORN"), "12345");
  assert.deepEqual(child(l, "Portals").children.map((p) => p.text), ["Bayut", "dubizzle"]);
  assert.equal(textOf(l, "Last_Updated"), "2026-11-06 09:30:00");
});

test("whatever staff type, the document stays well formed and says what they typed", () => {
  const nasty = { ...LISTING, title: "Sea <b>view</b> & more", building: `Tower "A" & 'B'`, description: "Ends ]]> here <script>&amp;" };
  const l = parse(bayutFeedXml([nasty], AT)).children[0];
  assert.equal(textOf(l, "Property_Title"), "Sea <b>view</b> & more");
  assert.equal(textOf(l, "Tower_Name"), `Tower "A" & 'B'`);
  assert.equal(child(l, "Property_Description").text, "Ends ]]> here <script>&amp;");
});

test("a listing only for dubizzle names only dubizzle; Property Finder is never in this feed", () => {
  const l = parse(bayutFeedXml([{ ...LISTING, portals: ["dubizzle", "property_finder"] }], AT)).children[0];
  assert.deepEqual(child(l, "Portals").children.map((p) => p.text), ["dubizzle"]);
});

test("a studio prints 0 bedrooms; a sale has no rent frequency; unknown optional parts are left out", () => {
  const sale = { ...LISTING, purpose: "sale", bedrooms: 0, furnishing: null, subCommunity: null, building: null, parking: null, availableFrom: null };
  const l = parse(bayutFeedXml([sale], AT)).children[0];
  assert.equal(textOf(l, "Bedrooms"), "0");
  assert.equal(textOf(l, "Property_purpose"), "Buy");
  assert.equal(child(l, "Rent_Frequency"), undefined);
  assert.equal(child(l, "Furnished"), undefined);
  assert.equal(child(l, "Sub_Locality"), undefined);
  assert.equal(child(l, "Tower_Name"), undefined);
});
