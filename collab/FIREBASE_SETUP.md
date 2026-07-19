# Travel Planner Collab Firebase Setup

這是新版 `/collab/` 共編站台需要的 Firebase 設定。

## 1. 建立 Firebase 專案

1. 到 Firebase Console 建立專案。
2. 新增 Web App，複製 Firebase Web Config。
3. 在 Authentication 啟用 Anonymous 匿名登入。
4. 建立 Firestore Database。

## 2. 將 Web Config 放進 APP

第一階段可以在「旅程管理」裡貼上 Firebase Web Config JSON。

若要讓旅伴不用設定，可把 config 填進 `index.html` 的：

```js
const FIREBASE_WEB_CONFIG = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  appId: "..."
};
```

Firebase Web Config 不是資料庫密碼；真正的權限要靠 Firestore Rules。

## 3. 第一階段 Firestore Rules

這組規則適合小範圍旅伴共編：所有匿名登入使用者可讀寫 `trips`。
它先讓共編順手跑起來；之後再升級成 owner/editor/viewer 成員制。

```txt
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /trips/{tripId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## 4. 目前資料格式

第一階段為了保留既有功能，Firestore 先存整趟旅程文件：

```txt
trips/{tripId}
```

包含：

- title
- updatedAt
- updatedBy
- data.days
- activityLog
- storage: firebase-firestore
- schema: whole-trip-v1

下一階段再拆成 `days/spots/segments/logs` 子集合，降低多人同時編輯時的衝突。
