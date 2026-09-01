import { Router, type IRouter } from "express";
import healthRouter from "./health";
import activityRouter from "./activity";

const router: IRouter = Router();

router.use(healthRouter);
router.use(activityRouter);

export default router;
