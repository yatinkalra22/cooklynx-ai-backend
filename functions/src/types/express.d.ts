import {AuthUser} from "../middleware/tsoa-auth.middleware";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
