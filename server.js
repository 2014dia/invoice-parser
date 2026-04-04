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
- PO must come from "Customer Order No"
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});