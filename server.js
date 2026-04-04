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
- invoice_number MUST come from INVOICE box "N°"
- NEVER use top-right numbers
- invoice_date from INVOICE Date
- due_date from bottom "Due Date"
- reference from "Your Reference"
- total_amount from TOTAL DOCUMENT USD
- vendor = Lioher

Item rules:
- PANEL → quantity from EA
- EDGE → quantity from FT
- LAMINATE → same as panel

Examples:
"2 EA 108.339 FT2" → 2
"738.000 FT" → 738

Ignore FT2 values.

Return JSON only.`
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