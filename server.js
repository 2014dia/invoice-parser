import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "invoice-parser-endpoint" });
});

async function processFile(fileUrl) {
  const fileResponse = await fetch(fileUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*"
    }
  });

  if (!fileResponse.ok) {
    throw new Error(`Failed to download file: ${fileResponse.status}`);
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer());

  if (buffer.length < 500) {
    throw new Error("File too small — invalid");
  }

  return buffer;
}

/* ===========================
   RICHELIEU PARSER (FIXED)
   =========================== */
app.post("/parse-invoice", async (req, res) => {
  try {
    const vendor = String(req.body.vendor || "").trim();
    const fileUrl = String(req.body.file_url || req.body.file || "").trim();

    const fileBuffer = await processFile(fileUrl);

    const file = await client.files.create({
      file: await toFile(fileBuffer, "invoice.pdf"),
      purpose: "user_data"
    });

    const response = await client.responses.create({
      model: process.env.MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Extract invoice data from this invoice.

Return ONLY JSON.

Fields:
- invoice_number
- customer_order_no
- invoice_date
- due_date
- total_amount
- vendor

Rules:
Important rules for customer_order_no:

- customer_order_no MUST come ONLY from the field labeled "CUSTOMER ORDER NO".
- This field is located below the main header section of the invoice.
- It is typically a short text such as "PTO CLIPS", "V325", "V263", etc.
- NEVER use the value from "CUSTOMER NO".
- NEVER use "CUSTOMER FED ID".
- NEVER use "FEDERAL TAX NUMBER".
- NEVER use any value from the top row that includes "CUSTOMER NO", "STORE NO", or numeric identifiers.
- Even if "CUSTOMER NO" appears closer or more prominent, IGNORE it completely.
- If multiple values are nearby, ALWAYS choose the one directly under "CUSTOMER ORDER NO".
- If the correct field cannot be clearly read, return an empty string.
- Ignore all other IDs
- Normalize dates YYYY-MM-DD
- Return numbers without symbols`
            },
            {
              type: "input_file",
              file_id: file.id
            }
          ]
        }
      ],
      text: { format: { type: "json_object" } }
    });

    const parsed = JSON.parse(response.output_text);
    res.json(parsed);

  } catch (err) {
    console.error("richelieu error:", err);
    res.status(500).json({ error: "Failed to parse invoice" });
  }
});

/* ===========================
   LIOHER PARSER (NEW)
   =========================== */
app.post("/parse-invoice-lioher", async (req, res) => {
  try {
    const fileUrl = String(req.body.file_url || req.body.file || "").trim();

    if (!fileUrl) {
      return res.status(400).json({
        error: "Missing file_url. Send form data with file_url."
      });
    }

    const fileBuffer = await processFile(fileUrl);

    const file = await client.files.create({
      file: await toFile(fileBuffer, "lioher.pdf"),
      purpose: "user_data"
    });

    const response = await client.responses.create({
      model: process.env.MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Extract invoice data from this Lioher invoice.

Return ONLY JSON.

Header rules:
- invoice_number MUST come only from the blue table labeled "INVOICE", in the row labeled "N°".
- NEVER use the number at the top right near "Ship to".
- NEVER use customer/account/reference numbers from the top right area.
- For example, if the top right shows something like "430002556-1", that is NOT the invoice number.
- The correct invoice number is the value inside the INVOICE box next to "N°".
- invoice_date = value shown in the INVOICE box next to "Date"
- due_date = value shown near the bottom next to "Due Date"
- reference = value shown in the INVOICE box next to "Your Reference"
- total_amount = value shown in the blue box "TOTAL DOCUMENT USD"
- vendor = "Lioher"

Line item rules:
- Each line item must be returned in the "items" array.
- article_code = value in "# ARTICLE CODE"
- description = full item description text

Category rules:
- If description contains "PANEL", category = "panel"
- If description contains "EDGE", category = "edge"
- If description contains "LAMINATE", category = "laminate"

Subcategory rules:
- If description contains "SYNCRON", subcategory = "syncron"
- If description contains "ZENIT", subcategory = "zenit"
- If description contains "LUXE", subcategory = "luxe"
- If description contains "LAMINATE", subcategory = "laminate"
- If no subcategory is clear, return empty string

Quantity rules:
- PANEL: extract ONLY the number before "EA"
- LAMINATE: extract ONLY the number before "EA"
- EDGE: extract ONLY the number before "FT"
- Ignore FT2 values completely
- Example: "17 EA 613.920 FT2" => quantity_value = "17", quantity_unit = "EA"
- Example: "1476.000 FT" => quantity_value = "1476", quantity_unit = "FT"
- If FT has trailing zeros like 738.000, return "738"
- Do not guess

Aggregation rules:
- syncr_ea = sum of quantity_value for all PANEL items with subcategory "syncron"
- zen_ea = sum of quantity_value for all PANEL items with subcategory "zenit"
- lux_ea = sum of quantity_value for all PANEL items with subcategory "luxe"
- lam_ea = sum of quantity_value for all LAMINATE items
- eb_ft = sum of quantity_value for all EDGE items, regardless of subcategory
- IMPORTANT: EDGE items always go ONLY into eb_ft
- IMPORTANT: Do not put EDGE quantities into syncr_ea, zen_ea, lux_ea, or lam_ea

Jennifer example:
- PANEL SYNCRON 17 EA
- EDGE SYNCRON 1476 FT
- PANEL SYNCRON 2 EA
- EDGE SYNCRON 738 FT
Result:
- syncr_ea = "19"
- eb_ft = "2214"

Return JSON with these exact top-level fields:
- invoice_number
- invoice_date
- due_date
- reference
- total_amount
- vendor
- syncr_ea
- zen_ea
- lux_ea
- lam_ea
- eb_ft
- items

Return JSON only. No markdown. No explanation.`
            },
            {
              type: "input_file",
              file_id: file.id
            }
          ]
        }
      ],
      text: { format: { type: "json_object" } }
    });

    const parsed = JSON.parse(response.output_text);
    res.json(parsed);

  } catch (err) {
    console.error("lioher error:", err);
    res.status(500).json({ error: "Failed to parse Lioher invoice" });
  }
});

app.post("/parse-invoice-dixieply", async (req, res) => {
  try {
    const fileUrl = String(req.body.file_url || req.body.file || "").trim();

    if (!fileUrl) {
      return res.status(400).json({
        error: "Missing file_url. Send form data with file_url."
      });
    }

    const fileBuffer = await processFile(fileUrl);

    const file = await client.files.create({
      file: await toFile(fileBuffer, "dixieply.pdf"),
      purpose: "user_data"
    });

    const response = await client.responses.create({
      model: process.env.MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Extract invoice data from this Dixieply invoice.

Return ONLY JSON.

Field rules:
- invoice_number = value next to "Invoice #"
- invoice_date = value next to "Invoice Date"
- po_number = value next to "PO:"
- ref = value next to "Ref:"
- ship_date = value next to "Ship Date:"
- vendor = "Dixieply"

Important PO rules:
- po_number MUST come ONLY from the field labeled "PO:"
- NEVER use the value from "Ref:" as the PO
- NEVER use any other nearby field as the PO
- If "PO:" is blank, return empty string

Important payment_tendered_date rules:
- payment_tendered_date MUST come ONLY from the text line that starts with "Payment Tendered"
- Extract the date that appears immediately after the words "Payment Tendered"
- NEVER use invoice_date, order date, ship_date, or printed date as payment_tendered_date
- If the date after "Payment Tendered" cannot be clearly read, return empty string
- Do not guess
- Return payment_tendered_date exactly as read from that line, then normalize to YYYY-MM-DD only if unambiguous

Important total rules:
- total_amount = the invoice total charged for the invoice
- Use the invoice total / amount total from the pricing section
- IGNORE the Balance field because it may be 0.00 even when the invoice amount is nonzero
- Return total_amount as a plain number string without currency symbols or commas

Quantity rules:
- Read all item rows in the item table
- total_quantity = sum of all numeric values under "QTY ORDERED"
- If QTY ORDERED is missing or unreadable, use QTY SHIPPED
- Ignore UOM, Converted Qty, Price/UOM, and Amount when calculating total_quantity
- Do not guess

General rules:
- Normalize invoice_date and ship_date to YYYY-MM-DD if possible
- Return JSON only
- If any field cannot be clearly read, return empty string for that field

Return these exact fields:
- invoice_number
- invoice_date
- po_number
- ref
- ship_date
- payment_tendered_date
- total_amount
- total_quantity
- vendor`
            },
            {
              type: "input_file",
              file_id: file.id
            }
          ]
        }
      ],
      text: { format: { type: "json_object" } }
    });

    const parsed = JSON.parse(response.output_text);
    res.json(parsed);

  } catch (err) {
    console.error("dixieply error:", err);
    res.status(500).json({ error: "Failed to parse Dixieply invoice" });
  }
});

app.post("/parse-invoice-synergy", async (req, res) => {
  try {
    const fileUrl = String(req.body.file_url || req.body.file || "").trim();

    if (!fileUrl) {
      return res.status(400).json({
        error: "Missing file_url. Send form data with file_url."
      });
    }

    const fileBuffer = await processFile(fileUrl);

    const file = await client.files.create({
      file: await toFile(fileBuffer, "synergy.pdf"),
      purpose: "user_data"
    });

    const response = await client.responses.create({
      model: process.env.MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Extract invoice data from this Synergy Thermal Foils invoice.

Return ONLY JSON.

Header rules:
- invoice_number = value next to "Invoice #"
- invoice_date = value next to "Date"
- po_number = value under "P.O. Number"
- total_amount = value next to "Balance Due"
- vendor = "Synergy"

Line item rules:
- Read all rows in the item table under the Description / Quantity section.
- quantity_value = value under the "Quantity" column for each row
- quantity is always numeric like 1, 2, 3, etc.
- Ignore U/M, Price Each, and line Amount for total_quantity purposes.

Aggregation rules:
- total_quantity = sum of all quantity_value values from all rows

Examples:
- If quantities are 3, 2, 1, 1 then total_quantity = 7
- If quantity is 1 on a single-row invoice then total_quantity = 1

General rules:
- Normalize invoice_date to YYYY-MM-DD if possible
- Return total_amount as a plain number string without currency symbols or commas
- Return JSON only

Return these exact fields:
- invoice_number
- invoice_date
- po_number
- total_amount
- total_quantity
- vendor`
            },
            {
              type: "input_file",
              file_id: file.id
            }
          ]
        }
      ],
      text: { format: { type: "json_object" } }
    });

    const parsed = JSON.parse(response.output_text);
    res.json(parsed);

  } catch (err) {
    console.error("synergy error:", err);
    res.status(500).json({ error: "Failed to parse Synergy invoice" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});