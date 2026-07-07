export function buildFortuneFlex(num, personalDay, description) {
  return {
    type: "flex",
    altText: `あなたの秘数は【${num}】です`,
    contents: {
      //       - bubble → 1枚のカード
      // - carousel → 複数のbubbleを横スワイプで並べる
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "数秘術鑑定",
            weight: "bold",
            size: "xs",
            color: "#9B59B6",
          },
          {
            type: "text",
            text: `${num}`,
            weight: "bold",
            size: "5xl",
            align: "center",
            color: "#6C3483",
            margin: "lg",
          },
          {
            type: "text",
            text: `秘数 ${num}`,
            align: "center",
            size: "sm",
            color: "#888888",
          },
          {
            type: "text",
            text: `パーソナルデー: ${personalDay}`,
            align: "center",
            size: "sm",
            color: "#888888",
            margin: "sm",
          },
          {
            type: "separator",
            margin: "lg",
          },
          {
            type: "text",
            text: description,
            wrap: true,
            size: "sm",
            margin: "lg",
            color: "#333333",
          },
        ],
        paddingAll: "20px",
        backgroundColor: "#F8F4FC",
      },
    },
  };
}
