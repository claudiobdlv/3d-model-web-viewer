import express from "express";
import { listJobs } from "../db.js";

export const jobsRouter = express.Router();

jobsRouter.get("/", (_req, res) => {
  res.json(listJobs());
});
