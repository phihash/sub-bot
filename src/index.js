import { verifySignature } from "./verify.js";
import {
  calcNumber,
  calcPersonalDay,
  calcPersonalYear,
  getDescription,
} from "./numerology.js";
import { notifySlack } from "./notify.js";
import { buildFortuneFlex } from "./flex.js";
import { drawCard } from "./tarot.js";
import { registerUser, softDeleteUser } from "./db.js";
import { reply, push, showLoading, handleLifecycleEvent } from "./line.js";

export default {
  async fetch(request, env, ctx) {
    // POST以外のリクエストはOKを返す（ヘルスチェック用）
    if (request.method !== "POST") {
      return new Response("OK");
    }
    // リクエストボディを取得
    const rawBody = await request.text();

    // 署名検証
    const signature = request.headers.get("x-line-signature");
    if (
      !signature ||
      !(await verifySignature(rawBody, signature, env.LINE_CHANNEL_SECRET))
    ) {
      return new Response("Invalid signature", { status: 401 });
    }

    // リクエストボディをJSONに変換
    const body = JSON.parse(rawBody);

    for (const event of body.events) {
      if (
        await handleLifecycleEvent(event, {
          onFollow: async (userId) => {
            await registerUser(env.DB, userId);
            await notifySlack(env.SLACK_WEBHOOK_URL, `🟢 友だち追加: ${userId}`);
          },
          onUnfollow: async (userId) => {
            await softDeleteUser(env.DB, userId);
            await notifySlack(env.SLACK_WEBHOOK_URL, `🔴 ブロック: ${userId}`);
          },
        })
      )
        continue;

      // postback（数秘のDatetime Picker）
      if (event.type === "postback") {
        if (event.postback.data === "action=numerology") {
          const date = event.postback.params.date;
          const birthday = date.replace(/-/g, "");
          const num = calcNumber(birthday, "lifepath");
          const personalDay = calcPersonalDay(birthday);
          const personalYear = calcPersonalYear(birthday);
          const desc = getDescription(num);

          await reply(env, event.replyToken, [
            buildFortuneFlex(num, personalDay, personalYear, desc),
            {
              type: "text",
              text: "タロット占いも試してみませんか？",
              quickReply: {
                items: [
                  {
                    type: "action",
                    action: {
                      type: "message",
                      label: "タロットカード",
                      text: "タロットカード",
                    },
                  },
                ],
              },
            },
          ]);

          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            `🤖 数秘送信 → 秘数${num} PD${personalDay} PY${personalYear}`,
          );
        }
        continue;
      }

      // メッセージ以外はスキップ
      if (event.type !== "message") continue;

      const userId = event.source.userId;
      const text = event.message.type === "text" ? event.message.text : null;
      const mode = await env.SESSION.get(userId);

      // テキスト以外
      if (!text) {
        await reply(env, event.replyToken, [
          { type: "text", text: "テキストメッセージを送ってください" },
        ]);
        continue;
      }

      // タロットモード → Queueに投げて即座にResponse返す
      if (mode === "タロット") {
        const card = drawCard();

        await showLoading(env, userId);

        await env.TAROT_QUEUE.send({ userId, text, card });
        await env.SESSION.delete(userId);

        return new Response("OK");
      }

      // メニュー選択
      let message;
      if (text === "数秘") {
        message = {
          type: "flex",
          altText: "生年月日を選択してください",
          contents: {
            type: "bubble",
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: "数秘術鑑定",
                  weight: "bold",
                  size: "md",
                  color: "#9B59B6",
                },
                {
                  type: "text",
                  text: "生年月日を選択してください",
                  size: "sm",
                  color: "#888888",
                  margin: "md",
                },
              ],
              paddingAll: "20px",
              backgroundColor: "#F8F4FC",
            },
            footer: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "button",
                  action: {
                    type: "datetimepicker",
                    label: "生年月日を選ぶ",
                    data: "action=numerology",
                    mode: "date",
                    initial: "2000-01-01",
                    max: new Date().toISOString().slice(0, 10),
                    min: "1920-01-01",
                  },
                  style: "primary",
                  color: "#9B59B6",
                },
              ],
              paddingAll: "20px",
              backgroundColor: "#F8F4FC",
            },
          },
        };
      } else if (text === "タロットカード") {
        await env.SESSION.put(userId, "タロット", { expirationTtl: 300 });
        message = { type: "text", text: "相談内容を入力してください" };
      } else {
        message = { type: "text", text: "メニューを選んでください" };
      }

      const messages = Array.isArray(message) ? message : [message];
      await reply(env, event.replyToken, messages);

      const logText = messages
        .map((m) =>
          m.type === "flex"
            ? m.altText
            : m.type === "image"
              ? m.originalContentUrl
              : m.text,
        )
        .join(" | ");
      await notifySlack(env.SLACK_WEBHOOK_URL, `🤖 送信 → ${logText}`);
    }

    return new Response("OK");
  },

  // Queue consumer: タロットAI処理
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { userId, text, card } = msg.body;
      console.log("queue processing, card:", card.name);

      let aiText;
      try {
        const aiResponse = await env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          {
            messages: [
              {
                role: "system",
                content: `あなたは経験豊富なタロット占い師です。以下のルールを必ず守ってください。
- 相談者の悩みに対して、引いたカードの意味を踏まえた具体的なアドバイスをする
- カードの一般的な説明はせず、相談内容に直接結びつけて回答する
- 「〜しましょう」「〜してみて」のような親しみやすい口調で話す
- 150文字以内で簡潔に回答する
- 日本語で回答する`,
              },
              {
                role: "user",
                content: `引いたカード: ${card.name}
カードのキーワード: ${card.description}
相談内容: ${text}`,
              },
            ],
          },
        );
        console.log("AI response:", JSON.stringify(aiResponse));
        aiText = aiResponse.response;
      } catch (e) {
        console.log("AI error:", e.message);
      }

      if (!aiText) {
        await push(env, userId, [
          {
            type: "text",
            text: "申し訳ありません、鑑定に失敗しました。もう一度お試しください。",
          },
        ]);
        await notifySlack(env.SLACK_WEBHOOK_URL, `❌ AI失敗`);
        msg.ack();
        continue;
      }

      const pushRes = await push(env, userId, [
        {
          type: "image",
          originalContentUrl: card.imageUrl,
          previewImageUrl: card.imageUrl,
        },
        { type: "text", text: `${card.name}\n\n${aiText}` },
      ]);

      if (!pushRes.ok) {
        const errBody = await pushRes.text();
        console.log("Push message failed:", pushRes.status, errBody);
        await notifySlack(
          env.SLACK_WEBHOOK_URL,
          `❌ Push失敗 (${pushRes.status}): ${errBody}`,
        );
      } else {
        await notifySlack(
          env.SLACK_WEBHOOK_URL,
          `🤖 送信 → ${card.name}: ${aiText}`,
        );
      }

      msg.ack();
    }
  },
};
