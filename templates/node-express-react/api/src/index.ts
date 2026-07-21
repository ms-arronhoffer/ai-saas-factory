import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8000);
createApp().listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", msg: `API listening on :${port}` }));
});
