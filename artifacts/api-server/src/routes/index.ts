import { Router, type IRouter } from "express";
import healthRouter from "./health.ts";
import activityRouter from "./activity.ts";

const router: IRouter = Router();

router.use(healthRouter);
router.use(activityRouter);

export default router;
