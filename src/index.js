import { verifySignature } from "./verify.js";
import { isValidBirthday } from "./validate.js";
import { calcNumber, calcPersonalDay, getDescription } from "./numerology.js";
import { notifySlack } from "./notify.js";
import { buildFortuneFlex } from "./flex.js";
import { drawCard } from "./tarot.js";
import { registerUser } from "./db.js";

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

    //ここからがメイン
    // タロット処理を先にチェック → Queueに投げて即座にResponse返す
    for (const event of body.events) {
      if (event.type !== "message" || event.message.type !== "text") continue;
      const userId = event.source.userId;
      const text = event.message.text;
      const mode = await env.SESSION.get(userId);

      console.log("tarot check, mode:", mode, "text:", text);
      if (mode === "タロット") {
        const card = drawCard();
        console.log("sending to queue, card:", card.name);

        // ローディングアニメーション表示
        await fetch("https://api.line.me/v2/bot/chat/loading/start", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
          body: JSON.stringify({ chatId: userId, loadingSeconds: 60 }),
        });

        // Queueにタロット処理を投げる
        await env.TAROT_QUEUE.send({ userId, text, card });
        await env.SESSION.delete(userId);

        return new Response("OK");
      }
    }

    // タロット以外の通常処理
    await Promise.all(
      body.events.map(async (event) => {
        if (event.type === "follow") {
          await registerUser(env.DB, event.source.userId);
          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            `🟢 友だち追加: ${event.source.userId}`,
          );
          return;
        }
        if (event.type === "unfollow") {
          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            `🔴 ブロック: ${event.source.userId}`,
          );
          return;
        }
        if (event.type === "join") {
          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            `📥 グループに参加: ${event.source.groupId}`,
          );
          return;
        }
        if (event.type === "leave") {
          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            `📤 グループから退出: ${event.source.groupId}`,
          );
          return;
        }
        if (event.type === "postback") {
          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            `📩 ポストバック: ${event.postback.data}`,
          );
          return;
        }
        if (event.type === "memberJoined") {
          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            "👋 メンバーがグループに参加",
          );
          return;
        }
        if (event.type === "memberLeft") {
          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            "👋 メンバーがグループから退出",
          );
          return;
        }
        if (event.type !== "message") return;

        const time = new Date(event.timestamp).toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
        });
        const userText =
          event.message.type === "text"
            ? event.message.text
            : `[${event.message.type}]`;

        await notifySlack(
          env.SLACK_WEBHOOK_URL,
          [
            `💬 受信`,
            `ユーザー: ${event.source.userId}`,
            `メッセージ: ${userText}`,
            `メッセージID: ${event.message.id}`,
            `イベントID: ${event.webhookEventId}`,
            `日時: ${time}`,
          ].join("\n"),
        );

        const userId = event.source.userId;
        const text = event.message.type === "text" ? event.message.text : null;

        const mode = await env.SESSION.get(userId);
        let message;

        if (!text) {
          message = {
            type: "text",
            text: "テキストメッセージを送ってください",
          };

          // メニュー選択 → セッション保存
        } else if (text === "数秘" || text === "パーソナルイヤー") {
          await env.SESSION.put(userId, text, { expirationTtl: 300 });
          message = {
            type: "text",
            text: "生年月日を8桁で入力してください（例: 19990421）",
          };
        } else if (text === "タロットカード") {
          await env.SESSION.put(userId, "タロット", { expirationTtl: 300 });
          message = { type: "text", text: "相談内容を入力してください" };

          // セッションあり → モードに応じた処理
        } else if (mode === "数秘" && isValidBirthday(text)) {
          const num = calcNumber(text, "lifepath");
          const personalDay = calcPersonalDay(text);
          const desc = getDescription(num);
          message = [
            buildFortuneFlex(num, personalDay, desc),
            {
              type: "text",
              text: "他の占いも試してみませんか？",
              quickReply: {
                items: [
                  {
                    type: "action",
                    action: {
                      type: "message",
                      label: "パーソナルイヤー",
                      text: "パーソナルイヤー",
                    },
                  },
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
          ];
          await env.SESSION.delete(userId);
        } else if (mode === "パーソナルイヤー" && isValidBirthday(text)) {
          const year = new Date().getFullYear().toString();
          const monthDay = text.slice(4, 8);
          const num = calcNumber(year + monthDay, "personalyear");
          const desc = getDescription(num);
          message = {
            type: "text",
            text: `${year}年のパーソナルイヤーは【${num}】です\n${desc}`,
          };
          await env.SESSION.delete(userId);

          // セッションありだが入力が不正
        } else if (mode === "数秘" || mode === "パーソナルイヤー") {
          message = {
            type: "text",
            text: "生年月日を8桁で入力してください（例: 19990421）",
          };

          // セッションなし
        } else {
          message = { type: "text", text: "メニューを選んでください" };
        }

        const messages = Array.isArray(message) ? message : [message];

        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
          body: JSON.stringify({
            replyToken: event.replyToken,
            messages,
          }),
        });

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
      }),
    );

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
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
          body: JSON.stringify({
            to: userId,
            messages: [
              {
                type: "text",
                text: "申し訳ありません、鑑定に失敗しました。もう一度お試しください。",
              },
            ],
          }),
        });
        await notifySlack(env.SLACK_WEBHOOK_URL, `❌ AI失敗`);
        msg.ack();
        continue;
      }

      const pushRes = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          to: userId,
          messages: [
            {
              type: "image",
              originalContentUrl: card.imageUrl,
              previewImageUrl: card.imageUrl,
            },
            { type: "text", text: `${card.name}\n\n${aiText}` },
          ],
        }),
      });

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
