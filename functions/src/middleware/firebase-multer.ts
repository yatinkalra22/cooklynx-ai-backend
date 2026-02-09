import {Request, Response, NextFunction} from "express";
import Busboy from "busboy";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

type MulterCompatRequest = Omit<RawBodyRequest, "file" | "files"> & {
  files?: {[fieldname: string]: ParsedFile[]};
  file?: ParsedFile;
};

interface ParsedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/**
 * Middleware to parse multipart form data in Firebase Cloud Functions.
 *
 * Firebase Functions pre-parses the request body and provides it as `rawBody`.
 * Standard multer fails because it tries to read from the request stream which is already consumed.
 *
 * This middleware:
 * 1. Intercepts multipart requests BEFORE they reach multer
 * 2. Parses files from rawBody using busboy
 * 3. Sets req.file and req.files so multer-dependent code works
 * 4. Lets tsoa's multer middleware pass through without re-parsing
 */
export function firebaseMulterMiddleware() {
  return async (req: RawBodyRequest, res: Response, next: NextFunction) => {
    const contentType = req.headers["content-type"] || "";

    // Only handle multipart requests
    if (!contentType.includes("multipart/form-data")) {
      return next();
    }

    const rawBody = req.rawBody;

    if (!rawBody || rawBody.length === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Empty request body for multipart upload",
      });
    }

    try {
      const files = await parseMultipartFromBuffer(rawBody, req.headers);

      const multerReq = req as MulterCompatRequest;

      // Set req.files for multer compatibility (used by upload.fields())
      const filesObject: {[fieldname: string]: ParsedFile[]} = {};
      for (const file of files) {
        if (!filesObject[file.fieldname]) {
          filesObject[file.fieldname] = [];
        }
        filesObject[file.fieldname].push(file);
      }
      multerReq.files = filesObject;

      // Also set req.file for single file uploads (used by upload.single())
      if (files.length > 0) {
        multerReq.file = files[0];
      }

      next();
    } catch (error) {
      res.status(400).json({
        error: "Bad Request",
        message: "Failed to parse multipart form data",
      });
    }
  };
}

function parseMultipartFromBuffer(
  buffer: Buffer,
  headers: Request["headers"]
): Promise<ParsedFile[]> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({headers});
    const files: ParsedFile[] = [];
    const filePromises: Promise<void>[] = [];

    busboy.on("file", (fieldname, fileStream, info) => {
      const chunks: Buffer[] = [];

      const filePromise = new Promise<void>((resolveFile) => {
        fileStream.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        fileStream.on("end", () => {
          const fileBuffer = Buffer.concat(chunks);
          files.push({
            fieldname,
            originalname: info.filename,
            encoding: info.encoding,
            mimetype: info.mimeType,
            buffer: fileBuffer,
            size: fileBuffer.length,
          });
          resolveFile();
        });

        fileStream.on("error", (err) => {
          console.error("File stream error:", err);
          resolveFile();
        });
      });

      filePromises.push(filePromise);
    });

    busboy.on("finish", async () => {
      await Promise.all(filePromises);
      resolve(files);
    });

    busboy.on("error", (error: Error) => {
      reject(error);
    });

    busboy.end(buffer);
  });
}

/**
 * Create a no-op multer instance for tsoa.
 * Since we parse files in our middleware, tsoa's multer just needs to pass through.
 * This prevents multer from trying to parse the already-consumed stream.
 */
export function createNoOpMulter() {
  // Return a middleware factory that does nothing (files already parsed)
  const noOp = {
    single: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    array: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    fields: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    none: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    any: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  };
  return noOp;
}
