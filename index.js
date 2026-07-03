"use strict";
require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

app.post("/webhook", line.middleware(config), (req, res) => {
  const event = req.body.events[0];

  res.json({ status: "ok" });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server listening on port ${port}...`);
});
