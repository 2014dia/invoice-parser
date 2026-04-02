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

app.post("/parse-invoice", async (req, res) => {
  try {
    const vendor = String(req.body.vendor || "").trim();
    const fileUrl = String(req.body.file_url || req.body.file || "").trim();

    if (!fileUrl) {
      return res.status(400).json({
        error: "Missing file_url. Send form data with vendor and file_url."
      });
    }

    // Download the file from Zapier/Gmail/Dropbox URL
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      throw new Error(`Failed to download file: ${fileResponse.status} ${fileResponse.statusText}`);
    }

    const arrayBuffer = await fileResponse.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    // Upload real file to OpenAI Files API
    const uploadedFile = await client.files.create({
      file: await toFile(fileBuffer, "invoice.pdf", { type: "application/pdf" }),
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
              text: `Extract invoice data from this PDF.

Return ONLY the schema fields.

Important rules:
- "customer_order_no" MUST come only from the field labeled "CUSTOMER ORDER NO." or "CUSTOMER ORDER NO".
- Copy the text exactly from that field.
- NEVER use "CUSTOMER FED ID".
- NEVER use "FEDERAL TAX NUMBER".
- NEVER use "CUSTOMER NO.".
- NEVER use "STORE NO.".
- If CUSTOMER ORDER NO is blank or unreadable, return an empty string.
- Do not guess.

Other rules:
- Vendor: ${vendor || "Unknown"}
- If a field is not present, return an empty string.
- Normalize dates to YYYY-MM-DD if possible.
- Return total_amount as a plain number string without currency symbols or commas.`
            },
            {
              type: "input_file",
              file_id: uploadedFile.id
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
              customer_order_no: { type: "string" },
              invoice_date: { type: "string" },
              due_date: { type: "string" },
              total_amount: { type: "string" },
              vendor: { type: "string" }
            },
            required: [
              "invoice_number",
              "customer_order_no",
              "invoice_date",
              "due_date",
              "total_amount",
              "vendor"
            ]
          }
        }
      }
    });

    console.log("OpenAI output_text:", response.output_text);

    const parsed = JSON.parse(response.output_text);
    return res.json(parsed);
  } catch (error) {
    console.error("parse-invoice error full:", error);

    return res.status(500).json({
      error: "Failed to parse invoice",
      details: error?.message || "Unknown error"
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Invoice parser listening on port ${port}`);
});