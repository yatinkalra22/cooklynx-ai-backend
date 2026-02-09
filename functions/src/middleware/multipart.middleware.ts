import {Request, Response, NextFunction} from "express";
import Busboy from "busboy";

// File parsed from multipart form data
export interface ParsedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

// Request with parsed file - uses Express.Multer.File for compatibility
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// Request with file property for setting parsed file
interface FileRequest extends Omit<Request, "file"> {
  file?: ParsedFile;
}

/**
 * Middleware to handle multipart form data in Firebase Cloud Functions.
 * Firebase Functions pre-parses the body, so we need to use rawBody.
 * @param fieldName The name of the file field to extract
 */
export function parseMultipart(fieldName: string) {
  return (req: RawBodyRequest, res: Response, next: NextFunction) => {
    const contentType = req.headers["content-type"] || "";

    if (!contentType.includes("multipart/form-data")) {
      return next();
    }

    // Use rawBody if available (Firebase Functions), otherwise collect from stream
    const rawBody = req.rawBody;

    if (rawBody && rawBody.length > 0) {
      return parseFromBuffer(req, res, next, fieldName, rawBody);
    }

    // rawBody not available or empty - need to collect from stream
    collectAndParse(req, res, next, fieldName);
  };
}

/**
 * Collect body from stream first, then parse with busboy
 * This handles cases where rawBody isn't set
 */
function collectAndParse(
  req: RawBodyRequest,
  res: Response,
  next: NextFunction,
  fieldName: string
) {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    const body = Buffer.concat(chunks);

    if (body.length === 0) {
      res.status(400).json({
        error: "Bad Request",
        message: "Empty request body",
      });
      return;
    }

    parseFromBuffer(req, res, next, fieldName, body);
  });

  req.on("error", (error: Error) => {
    console.error("Request error:", error);
    res.status(400).json({
      error: "Bad Request",
      message: "Failed to read request body",
    });
  });
}

function parseFromBuffer(
  req: RawBodyRequest,
  res: Response,
  next: NextFunction,
  fieldName: string,
  rawBody: Buffer
) {
  const busboy = Busboy({headers: req.headers});
  const chunks: Buffer[] = [];
  let fileInfo: Pick<
    ParsedFile,
    "fieldname" | "originalname" | "encoding" | "mimetype"
  > | null = null;

  busboy.on("file", (name, file, info) => {
    if (name !== fieldName) {
      file.resume(); // Skip files that don't match the field name
      return;
    }

    fileInfo = {
      fieldname: name,
      originalname: info.filename,
      encoding: info.encoding,
      mimetype: info.mimeType,
    };

    file.on("data", (data: Buffer) => {
      chunks.push(data);
    });
  });

  busboy.on("finish", () => {
    if (fileInfo && chunks.length > 0) {
      const buffer = Buffer.concat(chunks);
      // Use type assertion to set the file property
      // Express.Multer.File is compatible with our ParsedFile
      (req as FileRequest).file = {
        ...fileInfo,
        buffer,
        size: buffer.length,
      };
    }
    next();
  });

  busboy.on("error", (error: Error) => {
    console.error("Busboy error:", error);
    res.status(400).json({
      error: "Bad Request",
      message: "Failed to parse multipart form data",
    });
  });

  busboy.end(rawBody);
}
