import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const uploadDir = path.join(process.cwd(), "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "invoice-parser-endpoint" });
});

app.post("/parse-invoice", upload.single("file"), async (req, res) => {
  let localPath = null;

  try {
    const vendor = (req.body.vendor || "").trim();

    if (!req.file) {
      return res.status(400).json({
        error: "Missing file. Send multipart/form-data with field name 'file'."
      });
    }

    localPath = req.file.path;

    const uploaded = await client.files.create({
      file: fs.createReadStream(localPath),
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
              text:
                `Extract invoice data from this PDF. ` +
                `Return only the schema fields. ` +
                `Vendor: ${vendor || "Unknown"}. ` +
                `If a field is not present, return an empty string. ` +
                `Normalize dates to YYYY-MM-DD if possible. ` +
                `Return total_amount as a plain number string without currency symbol or commas.`
            },
            {
              type: "input_file",
              file_id: uploaded.id
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
  } finally {
    if (localPath && fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Invoice parser listening on port ${port}`);
});