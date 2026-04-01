import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

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

app.post("/parse-invoice", async (req, res) => {
  try {
    const vendor = (req.body.vendor || "").trim();
    const fileUrl = (req.body.file_url || req.body.file || "").trim();

    if (!fileUrl) {
      return res.status(400).json({
        error: "Missing file_url. Send form data with vendor and file_url."
      });
    }

    const response = await client.responses.create({
      model: process.env.MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                text:
  `Extract invoice data from this PDF.
   Return only the schema fields.
   Vendor: ${vendor || "Unknown"}.
   If a field is not present, return an empty string.
   Normalize dates to YYYY-MM-DD if possible.
   Return total_amount as a plain number string without currency symbol or commas.

   Very important rules for po_number:
   - po_number MUST come only from the field labeled "Customer Order No" or "Customer Order Number".
   - NEVER use "Customer Fed ID" for po_number.
   - NEVER use "Federal Tax Number" for po_number.
   - NEVER use "Customer No." for po_number.
   - NEVER use "Store No." for po_number.
   - If "Customer Order No" is blank or missing, return an empty string for po_number.
   - Do not guess.

   Return only the schema fields.`
            },
            {
              type: "input_file",
              file_url: fileUrl
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "invoice_extract",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              invoice_number: { type: "string" },
              po_number: { type: "string" },
              invoice_date: { type: "string" },
              due_date: { type: "string" },
              total_amount: { type: "string" },
              vendor: { type: "string" }
            },
            required: [
              "invoice_number",
              "po_number",
              "invoice_date",
              "due_date",
              "total_amount",
              "vendor"
            ]
          }
        }
      }
    });

    const parsed = JSON.parse(response.output_text);
    res.json(parsed);
  } catch (error) {
    console.error("parse-invoice error:", error);
    res.status(500).json({
      error: "Failed to parse invoice",
      details: error?.message || "Unknown error"
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Invoice parser listening on port ${port}`);
});