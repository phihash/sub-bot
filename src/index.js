import { verifySignature } from "./verify.js";
import {
  calcNumber,
  calcPersonalDay,
  calcPersonalYear,
  getDescription,
} from "./numerology.js";
import { notifySlack } from "./notify.js";
import { buildFortuneFlex } from "./flex.js";
import { drawCards } from "./tarot.js";
import { registerUser, softDeleteUser } from "./db.js";
import { reply, push, showLoading } from "./line.js";
import { tarotPrompts } from "./prompts.js";

export default {
  async fetch(request, env) {
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
      switch (event.type) {
        case "follow": {
          await registerUser(env.DB, event.source.userId);
          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            `🟢 友だち追加: ${event.source.userId}`,
          );
          break;
        }

        case "unfollow": {
          await softDeleteUser(env.DB, event.source.userId);
          await notifySlack(
            env.SLACK_WEBHOOK_URL,
            `🔴 ブロック: ${event.source.userId}`,
          );
          break;
        }

        case "postback": {
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
          break;
        }

        case "message": {
          const userId = event.source.userId;
          const text =
            event.message.type === "text" ? event.message.text : null;
          const mode = await env.SESSION.get(userId);

          // テキスト以外
          if (!text) {
            await reply(env, event.replyToken, [
              { type: "text", text: "テキストメッセージを送ってください" },
            ]);
            break;
          }

          // タロットモード → Queueに投げて即座にResponse返す
          if (mode?.startsWith("タロット:")) {
            const spread = mode.split(":")[1];
            const cardCount =
              { ワンオラクル: 1, ツーカード: 2, スリーカード: 3 }[spread] || 1;
            const cards = drawCards(cardCount);

            await showLoading(env, userId);

            await env.TAROT_QUEUE.send({ userId, text, cards, spread });
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
            message = {
              type: "text",
              text: "スプレッドを選んでください",
              quickReply: {
                items: [
                  {
                    type: "action",
                    action: {
                      type: "message",
                      label: "ワンオラクル",
                      text: "ワンオラクル",
                    },
                  },
                  {
                    type: "action",
                    action: {
                      type: "message",
                      label: "ツーカード",
                      text: "ツーカード",
                    },
                  },
                  {
                    type: "action",
                    action: {
                      type: "message",
                      label: "スリーカード",
                      text: "スリーカード",
                    },
                  },
                ],
              },
            };
          } else if (
            text === "ワンオラクル" ||
            text === "ツーカード" ||
            text === "スリーカード"
          ) {
            await env.SESSION.put(userId, `タロット:${text}`, {
              expirationTtl: 300,
            });
            const spreadGuide = {
              ワンオラクル: {
                title: "ワンオラクル",
                desc: "1枚のカードからメッセージを受け取ります",
                prompt: "今気になっていることを入力してください",
                example: "例: 今日の運勢、仕事の悩み",
              },
              ツーカード: {
                title: "ツーカード",
                desc: "2つの対象を比較して占います",
                prompt: "比較したい2つを入力してください",
                example: "例: Aの服とBの服、転職か残留か",
              },
              スリーカード: {
                title: "スリーカード",
                desc: "過去・現在・未来の流れを読みます",
                prompt: "流れを知りたいテーマを入力してください",
                example: "例: 今の恋愛の行方、キャリアの展望",
              },
            };
            const guide = spreadGuide[text];
            message = {
              type: "flex",
              altText: guide.prompt,
              contents: {
                type: "bubble",
                body: {
                  type: "box",
                  layout: "vertical",
                  contents: [
                    {
                      type: "text",
                      text: guide.title,
                      weight: "bold",
                      size: "md",
                      color: "#9B59B6",
                    },
                    {
                      type: "text",
                      text: guide.desc,
                      size: "xs",
                      color: "#888888",
                      margin: "sm",
                    },
                    { type: "separator", margin: "lg" },
                    {
                      type: "text",
                      text: guide.prompt,
                      size: "sm",
                      color: "#333333",
                      margin: "lg",
                      wrap: true,
                    },
                    {
                      type: "text",
                      text: guide.example,
                      size: "xs",
                      color: "#AAAAAA",
                      margin: "sm",
                    },
                  ],
                  paddingAll: "20px",
                  backgroundColor: "#F8F4FC",
                },
              },
            };
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
          break;
        }
      }
    }

    return new Response("OK");
  },

  // Queue consumer: タロットAI処理
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { userId, text, cards, spread } = msg.body;
      const cardList = cards;
      console.log(
        "queue processing, spread:",
        spread,
        "cards:",
        cardList.map((c) => c.name),
      );

      const cardsInfo = cardList
        .map(
          (c, i) =>
            `カード${i + 1}: ${c.name}${c.symbolism ? `\n象徴: ${c.symbolism}` : ""}\n${c.description}`,
        )
        .join("\n\n");

      let aiText;
      try {
        const systemPrompt = tarotPrompts[cardList.length];

        const aiResponse = await env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          {
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `${cardsInfo}\n相談内容: ${text}`,
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

      // スプレッドごとのラベル・色・分割パターン
      const spreadConfig = {
        1: {
          labels: [null],
          colors: ["#9B59B6"],
          splitPattern: null,
          useCardDesc: false,
        },
        2: {
          labels: [null, null],
          colors: ["#3498DB", "#E74C3C"],
          splitPattern: null,
          useCardDesc: true,
        },
        3: {
          labels: ["過去", "現在", "未来"],
          colors: ["#95A5A6", "#9B59B6", "#E67E22"],
          splitPattern: /【(?:過去|現在|未来)】/,
          useCardDesc: false,
        },
      };
      const config = spreadConfig[cardList.length];

      let aiTexts;
      let dynamicLabels = config.labels;
      let summaryText = null;

      if (config.useCardDesc) {
        // ツーカード: カードにはキーワードを表示、AIテキストは総合メッセージとして送る
        aiTexts = cardList.map((c) => c.description);
        summaryText = aiText;
      } else if (!config.splitPattern) {
        aiTexts = [aiText];
      } else {
        // スリーカード: 見出しで分割
        const headings = [...aiText.matchAll(/【([^】]+)】/g)].map((m) => m[1]);
        if (headings.length >= cardList.length) {
          dynamicLabels = headings.slice(0, cardList.length);
        }
        const parts = aiText.split(config.splitPattern).filter((s) => s.trim());
        aiTexts = cardList.map((_, i) => (parts[i] || "").trim());
      }

      // 共通のbubbleを生成
      const bubbles = cardList.map((card, i) => ({
        type: "bubble",
        hero: {
          type: "image",
          url: card.imageUrl,
          size: "full",
          aspectRatio: "2:3",
          aspectMode: "cover",
        },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            ...(dynamicLabels[i]
              ? [
                  {
                    type: "text",
                    text: dynamicLabels[i],
                    weight: "bold",
                    size: "xs",
                    color: config.colors[i],
                  },
                ]
              : []),
            {
              type: "text",
              text: card.name,
              weight: "bold",
              size: "md",
              margin: "sm",
            },
            {
              type: "text",
              text: aiTexts[i] || card.description,
              wrap: true,
              maxLines: 0,
              size: "sm",
              color: "#333333",
              margin: "md",
            },
          ],
          paddingAll: "15px",
        },
      }));

      const cardNames = cardList.map((c) => c.name).join(" / ");
      const pushMessages = [
        {
          type: "flex",
          altText: cardNames,
          contents:
            bubbles.length === 1
              ? bubbles[0]
              : { type: "carousel", contents: bubbles },
        },
        ...(summaryText
          ? [
              {
                type: "flex",
                altText: summaryText.slice(0, 100),
                contents: {
                  type: "bubble",
                  body: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                      {
                        type: "text",
                        text: "総合鑑定",
                        weight: "bold",
                        size: "sm",
                        color: "#9B59B6",
                      },
                      { type: "separator", margin: "md" },
                      {
                        type: "text",
                        text: summaryText,
                        wrap: true,
                        maxLines: 0,
                        size: "sm",
                        color: "#333333",
                        margin: "md",
                        lineSpacing: "8px",
                      },
                    ],
                    paddingAll: "20px",
                    backgroundColor: "#F8F4FC",
                  },
                },
              },
            ]
          : []),
      ];

      const pushRes = await push(env, userId, pushMessages);

      if (!pushRes.ok) {
        const errBody = await pushRes.text();
        await notifySlack(
          env.SLACK_WEBHOOK_URL,
          `❌ Push失敗 (${pushRes.status}): ${errBody}`,
        );
      } else {
        const cardNames = cardList.map((c) => c.name).join(" / ");
        await notifySlack(
          env.SLACK_WEBHOOK_URL,
          `🤖 送信 → ${cardNames}: ${aiText.slice(0, 100)}`,
        );
      }

      msg.ack();
    }
  },
};
