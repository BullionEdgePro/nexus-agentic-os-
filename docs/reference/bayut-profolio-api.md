# Bayut Profolio API — integration reference

- **Date read:** 2026-11-23
- **Source:** https://developers.bayut.com (Apidog docs site, needs a signed-in Bayut user)
- **How:** read page by page in the browser. **Nothing was tested.** The API was not called. Everything below comes from the docs text, the field schemas and the examples.
- Where the docs contradict themselves, both versions are shown. "Unclear in docs" means the docs do not say.

---

## 1. Basics

| Item | What the docs say |
|---|---|
| Base URL | `https://api.bayut.com` + `/v1/...` on every endpoint page (e.g. `https://api.bayut.com/v1/properties`). The changelog and FAQ sometimes write `/api/v1/...` (e.g. `POST /api/v1/properties/{property_id}/products/attach`, `GET api/v1/users/{user}/wallets`). |
| Sandbox vs Production | **No sandbox URL is documented.** Only `https://api.bayut.com` appears. Some example responses contain staging-looking hosts (`https://nova.bayut.sector.run/v1/properties` in `links`/`meta.path`, and images on `assets.stage.bayut.com` / `assets.stage.bayut.sector.run`). The docs never present these as a sandbox. |
| Auth | `Authorization: Bearer <token>`. Quickstart: "Visit the Profolio Sign-In Page and log in. Navigate to your dashboard to retrieve your API token." |
| Usage rule | "The API is intended strictly for server-to-server integration. Do not call it directly from browsers or mobile applications." |
| Format | "RESTful … JSON over HTTPS". Send `Content-Type: application/json` on bodies and `Accept: application/json`. |
| Optional fields | FAQ 4: if an optional field is null or empty, leave it out of the payload. **The request is rejected if an optional field is sent as null/empty.** |
| Numbers | FAQ 10: price, rent, area, plot_area and maintenance_fee accept decimals. Count fields (bedrooms, bathrooms) must be integers, or the API returns **422**. |
| Branch scoping | Changelog 13 Oct 2025: "API consumers can now pass an `agency_id` in query parameters or request bodies of selected endpoints (e.g., users, properties) to retrieve data scoped to a specific branch." Quickstart: `agency_id` = "The agency's branch ID". |

**Pagination (list endpoints such as properties, users, categories, amenities, locations, agencies):**
```json
"links": { "first": "...?page=1", "last": null, "prev": null, "next": "...?page=2" },
"meta":  { "current_page": 1, "from": 1, "path": "https://api.bayut.com/v1/users", "per_page": 20, "to": 1, "total": 1 }
```
Query param `per_page`. Leads return `meta` only (`page`, `per_page`, "max: 100"). Rejected properties return `pagination{current_page,total_pages,total_records}` and take `page` and `limit`.

**Rate limits** (Rate limits page): "evaluated per token", 60 requests per 1-minute window. The docs say not to hard-code this. Read these headers instead:
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`
- When the limit is exceeded: HTTP **429**, with `{"error": "Rate limit exceeded", "message": "Rate limit exceeded", "retry_after": 60}`. "Your application should rely on the `retry_after` field." Recommended: exponential backoff or queueing, and caching.

**Errors / status codes seen in the docs**
| Code | Shape / meaning |
|---|---|
| 201 / 200 | `{"message": "...", "data": {...}}` |
| 422 | Create: `{"message": string, "errors": object}` ("The list of errors with the description"). Publish example: `{"message":"string","errors":{"variant":["string"],"portal":["string"]}}`. Permit validate: `{"message":"The given data was invalid.","errors":[["The listing has failed the ADREC c…"]]}` (text cut off in the docs view). |
| 401 | "Unauthenticated". The body is not shown. |
| 403 | `{"message":"The action is not authorized."}` |
| 404 | Delete Property: "Not Found" |
| 409 | "Idempotency Conflict": `{"message": "Please wait! Your request is being processed."}`. This happens "when simultaneous or duplicate Create/Publish requests are made for the same listing reference while the current request is still being processed." No idempotency-key header is documented. |
| 400 / 503 | License Validation only (see §5) |

FAQ 7: every failed request returns an error code and a message. Codes are documented per endpoint only. There is no global error list.

**No XML feed is mentioned anywhere in the docs.** On CRMs, FAQ 6 says: "the CRM must periodically re-sync the property data to check for and capture any modifications made after initial publication". It also says a subscription-events (webhook) mechanism is "planned".

---

## 2. Create Property — `POST /v1/properties`

"Creating new property, it will automatically be saved as a **Draft**. To publish it, you will need to take a separate action … (e.g., using the Publish Property API)." Changelog 1 Dec 2025: auto-publish via Create is deprecated, and all new properties are drafts.

### Body fields (from the request schema)
| Field | Type | Req. | Rules / allowed values |
|---|---|---|---|
| `reference` | string | **required** | ≤255. "The unique property reference number." FAQ 15: "must be unique among active properties within the agency, can be edited, and may be reused once the previous property is deleted." |
| `title` | object | **required** | |
| `title.en` | string | **required** | ≤100 |
| `title.ar` | string\|null | optional | ≤100 |
| `description` | object | **required** | |
| `description.en` | string | **required** | ≤8000 |
| `description.ar` | string\|null | optional | ≤8000 |
| `user_id` | integer | **required** | "The ID of the user posting the property." |
| `user_email` | string `<email>` | marked "required" | "If a User ID is not provided, property can be created directly using the user's email address". Changelog 1 Jan 2026: "Clients may use either `user_id` or `user_email`." |
| `purpose` | enum | **required** | `sale`, `rent` |
| `category` | string | **required** | "requires the slug of the Category" from `GET v1/categories`. Schema example `apartment`. The request example sends `"Apartments"`, the Quickstart sends `"apartments"`, and the Update example sends `"villas"`. |
| `furnishing_status` | enum\|null | optional | `furnished`, `unfurnished` |
| `location_id` | integer | **required** | ID from `GET v1/locations` |
| `construction_status` | enum\|null | optional | `completed`, `under-construction` (the response calls it `completion_status`) |
| `price` | number | **required** | ≥1, ≤999999999 |
| `rental_details` | object\|null | optional | "The details required if the purpose is `rent`." |
| `rental_details.occupancy_status` | enum\|null | optional | `vacant`, `rented` |
| `rental_details.rent_frequency` | enum | optional* | `daily`, `weekly`, `monthly`, `yearly`. *"Required if purpose = rent." |
| `rental_details.minimum_contract_period` | integer\|null | optional | months, 1–120 |
| `rental_details.vacating_notice_period` | integer\|null | optional | months, 1–12 |
| `rental_details.maintenance_fee` | number\|null | optional | 0–999999 |
| `rental_details.maintenance_fee_paid_by` | enum\|null | optional | `landlord`, `tenant` |
| `sale_details` | object\|null | optional | "Details required if the purpose is 'sale'." |
| `sale_details.financing_available` | enum\|null | optional | Create page: `yes`, `not sure`. Update page: `yes`, `no`, `not sure`. |
| `sale_details.financing_institute` | string\|null | optional | ≤255 |
| `sale_details.sale_type` | string\|null | optional | "Off-plan sale type must be either new or resale" (`new`, `resale`) |
| `offplan_details` | object\|null | optional | "Off plan details only for properties in Emirates outside of Dubai" |
| `offplan_details.sale_type` | string | optional | "new or resale" |
| `area` | number | **required** | built-up area, **sqft**, 1–999999 |
| `plot_area` | number\|null | optional | sqft, 0–999999 |
| `bedrooms` | integer\|null | optional | −1 to 20. "Use -1 for studio." |
| `bathrooms` | integer\|null | optional | 0–20 |
| `permit_number` | string\|null | optional | ≤255. "The permit number issued by the authority." |
| `ownership_status` | enum\|null | optional | `freehold`, `leasehold` |
| `amenities` | array[object]\|null | optional | ≤100 items |
| `amenities[].id` | string\|null | **required** | ID from `GET v1/amenities` |
| `amenities[].value` | string | optional (Default `true`) | ≤255. A boolean ("Gym: true") or a number ("Elevators in Building: 23"). FAQ 14 and the Update page say `value` is **required** whenever an amenity is sent. |
| `images` | array[object] | **required** | **1–100 items** |
| `images[].title` | string\|null | optional | ≤255 |
| `images[].path` | string `<uri>` | **required** | ≤2048. "Full URL to the image." |
| `images[].is_main` | boolean | **required** | "Whether this image is the main property image." |
| `videos` | array[object]\|null | optional | ≤10 items |
| `videos[].title` | string\|null | optional | ≤255 |
| `videos[].host` | enum\|null | optional | `youtube`, `vimeo`, `dailymotion`, `3d_view` |
| `videos[].link` | string `<uri>`\|null | optional | ≤2048 |

**Required fields:** `reference`, `title.en`, `description.en`, `user_id` (or `user_email`), `purpose`, `category`, `location_id`, `price`, `area`, `images` (≥1, each with `path` + `is_main`). Also `rental_details.rent_frequency` when `purpose = rent`.

Notes:
- **Units:** area and plot_area are in sqft (the response returns `"area_unit": "sqft"`). No currency field exists. The rejected-properties payload calls the price `price_aed`.
- **Images:** sent as URLs only (`path`). No upload endpoint is documented. No format, size, resolution, ordering or count rules beyond 1–100. The main image is set with `is_main: true`. In responses, images come back re-hosted as `{"url": "https://assets.bayut.com/listing-images/…", "is_main": true}`. Moderation can reject listings, for example "Images are misleading".
- **Agent:** chosen with `user_id` (find it with `GET /v1/users?agency_id=<branch id>`) or with `user_email`. The property has no BRN field. The response `user_detail` includes `brn_number` and `bln_number`.
- **Permit / RERA / Trakheesi:** the only field is `permit_number`. FAQ 2: optional at creation, but "mandatory with specific length and format rules when you attempt to activate (publish) a property in … Dubai, Abu Dhabi, or Al Ain". The length and format rules are not given. There is **no ORN/RERA-office field** anywhere.
- **Location:** FAQ 1 says locations "must resolve to a deep or exact address; Area or Emirate-level locations are rejected". Validation also "differ[s] based on whether the location is designated as off-plan or ready".
- **`portals` on create:** the Quickstart example sends `"portals": ["bayut"]`, and its table describes it as "The portal where you want to upload the property". **The Create schema does not list `portals`.** Publishing goes through the Publish endpoint (§3).
- The response `offplan_details` also has `dld_waiver`, `original_price` and `amount_paid`, and the response has `completion_date`. None of these are in the request schema.

### Request example (trimmed from the docs)
```json
{
  "reference": "REF-1283912839",
  "title": { "en": "Luxury 3BR Apartment in Downtown Dubai", "ar": "…" },
  "description": { "en": "Beautiful luxury apartment …", "ar": "…" },
  "user_id": 2318195,
  "purpose": "rent",
  "category": "Apartments",
  "furnishing_status": "furnished",
  "location_id": 14550,
  "construction_status": "completed",
  "price": 150000,
  "rental_details": { "occupancy_status": "vacant", "rent_frequency": "yearly", "minimum_contract_period": 12,
                      "vacating_notice_period": 3, "maintenance_fee": 5000, "maintenance_fee_paid_by": "tenant" },
  "sale_details": { "financing_available": "yes", "financing_institute": "Emirates NBD" },
  "offplan_details": { "sale_type": "new" },
  "area": 1200, "plot_area": 1500, "bedrooms": 3, "bathrooms": 2,
  "permit_number": "PERMIT-12345",
  "ownership_status": "freehold",
  "amenities": [ { "id": "9", "value": "true" }, { "id": "1", "value": "2026" }, { "id": "16", "value": "28" } ],
  "images": [ { "title": "Main Living Room", "path": "https://example.com/images/living-room.jpg", "is_main": true },
              { "title": "Kitchen", "path": "https://example.com/images/kitchen.jpg", "is_main": false } ],
  "videos": [ { "title": "Property Tour", "host": "youtube", "link": "https://www.youtube.com/watch?v=example" },
              { "title": "3D Virtual Tour", "host": "3d_view", "link": "https://example.com/3d-tour" } ]
}
```
(The docs example sends both `rental_details` and `sale_details` on a rent listing.)

### Response 201 (trimmed)
```json
{ "message": "Property created successfully",
  "data": { "id": 95, "reference": "REF-1283912839", "title": {...}, "description": {...},
    "bedrooms": 3, "bathrooms": 2, "area": 1200, "area_unit": "sqft", "price": 150000,
    "purpose": { "en": "To Rent", "ar": null },
    "category": { "id": 4, "title": { "en": "Apartments", "ar": "شقة" }, "parent_title": "Residential" },
    "rental_details": { "occupancy_status": "vacant", "rent_frequency": "yearly", "minimum_contract_period": "12", ... },
    "furnishing_status": "furnished", "completion_status": "completed", "completion_date": null,
    "comment": null, "verification_state": null,
    "permit": { "number": "PERMIT-12345", "status": "pending" },
    "location": { "id": 14550, "title": {...}, "breadcrumb": { "en": ["UAE","Dubai","Al Satwa","Jumeirah Garden City"], ... },
                  "coordinates": { "latitude": 25.22, "longitude": 55.27 } },
    "user_detail": { "id": 335478, "name": {...}, "brn_number": "202401381679", "bln_number": "202401381679",
                     "contact": { "email": "...", "phone": "...", "cell": null, "whatsapp": "..." } },
    "created_at": "2025-10-22T21:51:11.000000Z", "updated_at": "2025-10-22T21:51:12.000000Z" } }
```
Error responses: 422, 401, 403, 409 (see §1).

---

## 3. Update, Publish, Delete, Show/Get, Rejected, Permit validation

### Update — `PUT /v1/properties/{property_id}`
**This is a full replace, not a partial update.** The docs say: "All of the fields in the payload are compulsary, the ones changing will have the new value and the ones that are unchanged will have the existing value."
The body schema is the same as Create, with these differences:
- no `user_email`
- `financing_available` also allows `no`
- `offplan_details` and its `sale_type` are marked **required**
- `amenities[].value` is required

Response 200: `{"message": "Property updated successfully", "data": {...}}`. The 200 response schema also lists `portals`: array, ≥1 item, allowed `bayut`, `dubizzle`, "List of portals where the property should be posted". The request schema does not include it. Errors: 422, 401, 403.

### Publish — `POST /v1/properties/{property_id}/products/attach`
- Body (all marked optional):
  - `product` (string; examples `hot`, `signature`, `featured`, `premium`)
  - `portal` (string; `bayut` / `dubizzle`)
  - `portals` (shown as "string", described as "Array of portals, required when portal is not available")
- Rules (changelog 1 Jan 2026 and the page text):
  - "The `portals` array can only be used when publishing a property."
  - "You cannot use both `portal` and `portals` fields in the same request."
  - "If `product` is not provided, it automatically defaults to publishing listing."
- Examples: `{"portal": "bayut"}` and `{"portals": ["bayut", "dubizzle"]}`. A 422 example is triggered by `{"product": "hot"}` alone.
- **Asynchronous:** "When publishing a property for the first time in a location that requires a permit number, the publication is deferred. The property is published only after the permit number is validated by the relevant registration authority." FAQ 5: "The publish endpoint is not synchronous."
- Response 200: `{"message": "Product attached successfully"}`. Errors: 422 (`errors.variant[]`, `errors.portal[]`), 401, 403, 409.
- FAQ 12: the same `property_id` is used on both portals. To add the second portal later, call Publish again with the new portal. FAQ 9.1: to re-publish a deleted property, call this endpoint with the same property ID. It keeps the same ID, data and reference.
- Credits: see §6.

### Delete — `DELETE /v1/properties/{property_id}`
- Body: `portals` array[string], optional. Examples: `{"portals": ["bayut","dubizzle"]}` ("Double Portals") and a "Single Portal" variant.
- Response 200: `{"message": "Property deleted successfully!"}`. Errors: 404, 401, 403.
- FAQ 9: this is **not a hard delete**. The API "marks the property inactive on the requested portals without removing or hard deleting the record."

### Show — `GET /v1/properties/{property_id}`; Get — `GET /v1/properties`
- Get query params (all optional strings): `per_page`, `bayut_state`, `dubizzle_state`, `user_id`, `agency_id`, `category_id`, `location_id`, `min_price`, `max_price`, `reference`.
- Response `portals[]` item: `{ "id": 1, "name": "bayut", "state": "active", "published_at": "...", "refreshed_at": "...", "ad_products": [...] }`
  - `state` values seen in examples: **`active`, `draft`, `inactive`**. **No enum list or meanings are documented.** Quickstart: "data.portals.state shows that the property is active on bayut but draft on dubizzle".
  - `ad_products[]` example: `{ "id": 77, "name": "hot", "alias": { "l1": "Hot 7 days", "l2": null }, "expires_at": "2025-10-20 23:59:59", "auto_renew": 1, "created_at": "...", "updated_at": "..." }`
- Other response fields:
  - `verification_state` enum: `checked`, `truchecked` (or null)
  - `permit` `{number, status, comment}`. Example status is `"pending"`, example comment is "Compliance status is Pending our team's review". Other permit status values are not documented.
  - `offplan_details` `{sale_type, dld_waiver, original_price, amount_paid}`
  - `images[] {url, is_main}`, `videos[] {title, url}`, `amenities[] {id, title{en,ar}, value}`
  - `coordinates`, `user_detail` (includes `agency{id,name}` on Show)
- Get schema notes: `rental_details` is "shown only if purpose == 2", `sale_details` "only if purpose == 1".

### Rejected — `GET /v1/properties/rejected`
- Query: `rejection_type` ("all / moderation / permit"; the changelog says "all, moderation, or permit validation"), `page`, `limit`.
- Response:
```json
{ "status": "success",
  "pagination": { "current_page": 1, "total_pages": 1, "total_records": 2 },
  "data": [ { "property_details": { "id": 123, "reference_number": "PROP-REF-992A", "title_en": "...",
                "property_type": "Apartment", "bedrooms": "2", "purpose": "Sale", "price_aed": 2100000,
                "built_up_area_sqft": 1250.5, "plot_area_sqft": null, "submitted_permit_number": "123452025",
                "last_updated": "2026-09-11T06:54:00Z" },
              "validation_details": { "category": "Permit Validation", "status_code": "TRAKHEESI_PERMIT_EXPIRED",
                "description_en": "The provided DLD/Trakheesi permit number has expired or is no longer valid.",
                "description_ar": "…" } } ] }
```
- Moderation example: `category: "Moderation"`, `status_code: null`, `description_en: "Images are misleading"`. No list of status codes is documented.

### Permit number validation — `POST /v1/properties/{property_id}/permit/validate`
- Body: `{ "permit_number": "20250000537099" }` (required string).
- 200: `{"message": "Permit number is validated and the listing is made live."}`
- 422: `{"message": "The given data was invalid.", "errors": [[ "The listing has failed the ADREC c…" ]]}` (example name "Invalid ADREC Permit Number"). Errors: 401, 403.
- "If the permit number is invalid, the property is rejected." Validation "may include a verification of the associated agency's trade licenses", which are set via `PUT v1/agencies/{agency}`.
- FAQ 3: no standalone validation exists. The property must be created first.

---

## 4. Lookups

### Categories — `GET /v1/categories?title=&per_page=`
Item: `{ id, name{en,ar}, slug, subCategories[{id, name, slug}] }`. Send the **slug** as `category`.
- **residential** (id 1): `villas` (3), `apartments` (4), `residential-floor` (12), `residential-plots` (14), `townhouses` (16), `residential-building` (17), `penthouse` (18), `villa-compound` (19), `hotel-apartments` (21)
- **commercial** (id 2): `offices` (5), `shops` (6), `warehouses` (7), `factories` (8), `labour-camps` (9), `commercial-buildings` (10), `commerical-properties` (11, spelled this way in the docs), `commercial-floor` (13), `commercial-plots` (15), `bulk-units` (20), `industrial-land` (22), `mixed-use-land` (23), `showrooms` (24), `commercial-villas` (25)

### Amenities — `GET /v1/amenities?title=`
Example item:
```json
{ "id": 4, "title": { "en": "Barbeque Area", "ar": "…" }, "slug": "barbeque-area",
  "group": { "en": "Recreation and Family", "ar": "…" }, "type": "checkbox",
  "options": { "en": ["Yes","No"], "ar": ["نعم","لا"] }, "defaultValue": { "en": "No", "ar": "لا" },
  "portals": [ { "id": 1, "name": "Bayut" } ] }
```
- The schema also lists `externalTitle`, `index`, `purpose` (e.g. `rent`), `categories`, `externalTooltip` and `displayOrder`.
- `type` is the input type (e.g. `checkbox`, `text`, `number`). This was added on 2 Jul 2026.
- Create sends `{ "id": "<id as string>", "value": "<string>" }`. In the Show example, amenity id 1 is titled "Completion Year".

### Locations — `GET /v1/locations`
- Query: `title` (fuzzy match since 7 Jan 2026), `per_page`, `level_1` … `level_8`. The docs example uses `level_1=UAE`, `level_2=Dubai`, `level_3=Jumeirah`, `level_4=La Mer`, `level_5=Port de La Mer`, `level_6=La Sirene`, `level_7=La Sirene 2`, `level_8=La Sirene Tower 6`.
- Item: `{ id, title{en,ar}, breadcrumb{en[],ar[]}, coordinates{latitude,longitude} }`. The FAQ example also shows `level` and `hierarchy[]` (ids for each level).
- Hierarchy (FAQ 13): "Country → Emirate → Area → Community → Sub-community → Building/etc.", up to 8 levels.
- **Finding a `location_id`:** search by name, e.g. `?title=Dubai Marina` or `?title=Palm Jumeirah`. To narrow, add level filters, e.g. `level_2=Dubai&level_3=Dubai Marina`. Then pick the deepest match. The docs example result is `{"id": 5013, "title": {"en": "23 Marina"}, "breadcrumb": {"en": ["UAE","Dubai","Dubai Marina","23 Marina"]}}`. Area- or Emirate-level ids are rejected (FAQ 1). The docs do not give actual ids for Palm Jumeirah or Dubai Marina.
- FAQ 8: location data changes rarely. The docs recommend a quarterly full sync and a local cache.

---

## 5. Users & licences

- **List:** `GET /v1/users`. Query: `per_page`, `role` (e.g. `agent`), `agency_id` (branch), `email` ("substring. Minimum 3 characters"). Header `Accept: application/json`.
- **Show:** `GET /v1/users/{id}`. Other endpoints exist but were not read: Create (`POST /v1/users`), Update (`PUT /v1/users/{id}`), Delete User.
- **User fields:**
  - `id`, `name{en,ar}`, `about`, `gender`, `image`, `experience_in_years`, `country`
  - **`brn_number`** ("Broker Registration Number (BRN)") and **`bln_number`** ("Broker License Number (BLN)")
  - `contact{email, phone, cell, whatsapp}`
  - `role` (seen: `agent`, `agency-admin`, `agency-owner`)
  - `agency{id,name}`, `teams`, `languages`, `social_medias`, `specialities`, `speciality_areas`
  - The Get Users example wraps each item in an extra `"data"` key. The Quickstart example does not.
- Phone formats (changelog 6 Jul 2026): `phone` "+971-6-1234567 or +97161234567", and the same for `cell` and `whatsapp`. Values are stored exactly as sent.
- **Mapping agents:** a Profolio user is the agent. A property points to it with `user_id` or `user_email`. A BRN lives on the user, not on the property.

### License Validation — `POST /v1/users/{id}/license/validate`
- "Updates and validates the license of user i.e. BRN or BLN. If the license is valid, it is updated. The BLN should match Agency's Trade License."
- Body: `validation_type` (required: `bln` or `brn`) and `license_number` (required string).
- 200: `{"message": "Broker License Number (for Abu Dhabi & Al Ain) Validated Successfully!", "status": "valid"}`. `status` "could be valid, invalid or pending".
- 400 "Invalid License": `{message, status}`.
- 400 "License does not match Agency's Trade License.": `{message, status}`.
- 401, 403 (`{"message": "The action is not authorized."}`), and 503 "Could not validate at the moment".

### Agencies
- `GET /v1/agencies`. Query: `id`, `parent_id` (branch hierarchies), `search` (2–100 chars), `per_page` (default 20). Item: `{ id, parent_id, name, description, isExposure, contact{phone,email,website,address}, created_at }`. The page says it "lists agencies including linked branches".
- `GET /v1/agencies/{agency}` returns the same shape (`data` is an array in the example). `PUT /v1/agencies/{agency_id}` updates agency details, including Trade License (changelog 26 Oct 2025; not read).

---

## 6. Products & credits

### Attach Product — `POST /v1/properties/{property_id}/products/attach`
This is the same URL as Publish. It is used "to attach a product on a property e.g. Hot & Signature on Bayut and Featured & Premium on Dubizzle."

| Field | Req. | Values |
|---|---|---|
| `product` | required | `hot`, `signature` (Bayut); `featured`, `premium` (Dubizzle) |
| `variant` | required | `7_days`, `14_days`, `30_days` |
| `auto_renew` | optional | boolean: "True if product should auto-renew after period ends" |
| `portal` | required | `bayut`, `dubizzle` |

Example: `{"product": "hot", "variant": "7_days", "auto_renew": false, "portal": "bayut"}` returns `{"message": "Product attached successfully"}`.
On the Publish page, `product` and `variant` are optional, and leaving out `product` "defaults to publishing listing".

### Pricing — `GET /v1/properties/{property_id}/pricing?portal=bayut|dubizzle`
Leave `portal` out to get both portals. Response `data[] {product, variant, amount (integer), portal}`. Docs example:

| portal | product | 7_days | 14_days | 30_days |
|---|---|---|---|---|
| bayut | `publish-property` | – | – | 16 |
| bayut | `hot` | 237 | 281 | 431 |
| bayut | `signature` | 968 | 1076 | 1655 |
| dubizzle | `publish-property` | – | – | 15 |
| dubizzle | `featured` | 100 | 117 | 170 |
| dubizzle | `premium` | 543 | 636 | 924 |

The unit of `amount` (credits or AED) is **not stated**.

### Wallet — `GET /v1/users/{user}/wallets?portal=`
Leave `portal` out to get both portals. Response: `{"balance": {"personal": [], "agency": {"bayut": 39953, "dubizzle": 39925}}}`.
The changelog also lists `GET api/v1/consumptions` (Consumption Logs, "with filter support"). That page was not read.

**Does publishing spend credits?** The docs imply it but never say it outright:
- The pricing endpoint lists `publish-property` (30_days) with an `amount`.
- Wallets hold per-portal balances, and a consumption log exists.

No page explicitly says the wallet is debited on Publish or Attach. No page describes what happens when the balance is too low.

---

## 7. Leads

- **Pull:** `GET /v1/leads`.
  - Query: `channel` (`email` / `whatsapp` / `phone`), `target` (`listing`; the phone example has none), `is_lead` (1 = leads, 0 = views), `agency_ids[]`, `created_from` / `created_to` (YYYY-MM-DD), `page`, `per_page` (max 100), `enquirer_type` (`end_user` / `agent`).
  - Item: `lead{id "email|<uuid>", source "bayut", target, channel, date_time}`, `agent_details{url,name,email,phone,proxy_number}`, `listing_details{id, reference, category}`, `inquirer_details{name, cell, email, message, enquirer_type "End-User"/"Agent"}`.
  - WhatsApp items add `delivery_notifications[{status: sent|delivered|read|agent_contacted_lead, created_at}]`.
  - Phone items add `call_details{status, total_duration, connected_duration, recording_url, proxy_number, receiver_number, callback{...}}` and `agency_details{url,name}`.
  - 422 is a validation error. The docs say enriched fields fill in late, so re-pull history periodically.
  - Other pull pages exist but were not read: story, seller, views, user, agency, and project/off-plan leads.
- **Push (webhook):** Bayut POSTs JSON to an endpoint you register by emailing **support@bayut.com**.
  - Authenticity header: `X-Bayut-Signature` = `md5($secret_key . $body, false)`. Bayut provides the secret key after registration.
  - Call payload: `{id, agent{name,phone,email}, call_details{pickup_timestamp, call_status, proxy_number, receiver_number[], call_duration, call_total_duration}, enquirer{phone_number}}`.
  - WhatsApp payload: `{agent{url,id,name,email,phone_number}, listing{url, reference}, id, message, received_at, enquirer{name, contact_link, phone_number, intent}, wam_id}`. `agent` and `listing` are optional. `intent` is one of "Buying/Renting", "Selling/Leasing", "Investing", "General inquiry".
  - Changelog 8 Jul 2026: forward `contact_link` to agents. This is what turns the pull `agent_contacted_lead` status on.

---

## 8. Open questions (not answered by the docs)

1. **Sandbox / staging:** no sandbox base URL or test token process is documented. Only `https://api.bayut.com` appears. Examples leak `nova.bayut.sector.run` and `assets.stage.bayut.*`.
2. **Token:** lifetime, rotation, and scope (whole agency or one branch). Can one token act for several branches via `agency_id`?
3. **Images:** formats, minimum resolution, maximum file size, watermark rules. Must URLs stay reachable after create? Does an Update re-download images? Does order matter beyond `is_main`?
4. **Portal `state`:** the full enum and meanings (seen: `active`, `draft`, `inactive`). How does a deferred publish (pending permit) show up? There are no status webhooks; FAQ 6 says they are "planned".
5. **Permit rules:** the length and format per emirate (Dubai Trakheesi/DLD, Abu Dhabi/Al Ain ADREC) are not given. `permit.status` values beyond `pending` are unknown. There is no ORN / RERA-office field anywhere.
6. **`portals` on Create:** the Quickstart sends it, but the schema omits it. Is it ignored now that Create always makes a draft?
7. **Credits:** is the wallet debited automatically on Publish / Attach? Is `amount` in credits or AED? Which error comes back when the balance is too low? Does `publish-property` (30 days) renew or expire?
8. **Category slug case:** the schema example is `apartment`, the request example is `Apartments`, and the list slug is `apartments`.
9. **Off-plan:** `offplan_details` is "only for properties in Emirates outside of Dubai". How should Dubai off-plan be sent? `completion_date`, `dld_waiver`, `original_price` and `amount_paid` appear in responses but cannot be sent.
10. **Update contradictions:** `offplan_details` is required on Update even for ready units? `financing_available` allows `no` on Update but not on Create.
11. **409 Idempotency Conflict:** documented, but no idempotency-key header is documented.
12. **Rejected filter value:** `permit` or `permit validation`?
13. **401 body:** the shape is not shown.
14. **Before publishing in Dubai / Abu Dhabi:** must a user have a validated BRN/BLN? Must the agency trade licence be set first?
