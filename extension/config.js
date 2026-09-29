// 共享配置：好仓库白名单（内容脚本与后台/弹窗共用）
// 注意：content_scripts 与 background(importScripts) / popup(<script>) 三处都会加载本文件
var LX_CONFIG = {
  threshold: 3,
  warehouses: [
    "ONT8", "LGB8", "SBD1", "LAX9",
    "POC1", "POC2", "POC3", "GYR2",
    "GYR3", "LAS1", "VGT2", "XLX7",
    "PSP3", "SMF3", "SCK4", "GEU2",
    "GEU3", "MIT2", "SCK8", "HLI2",
    "IAZ1", "PHX5", "PHX7", "SMF6",
    "MCC1", "TCY1", "TCY2", "IUSJ",
    "IUSQ", "IUSP"
  ],
  // 无数字的4字母仓库码（如 IUSJ/IUSQ/IUSP）单独记录，用于全量提取
  extraCodePattern: "\\b[A-Z]{4}\\b",
  staUrl: "https://erp.lingxing.com/erp/msupply/AddSendToAmazon"
};
