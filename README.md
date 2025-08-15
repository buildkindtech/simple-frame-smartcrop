좋아요, 여기 README.md 내용 만들어드릴게요.
아래 내용 복사해서 `smart-crop-standalone` 폴더 안에 `README.md`로 저장하면 됩니다.

---

```markdown
# Smart Crop – Standalone (Client + Server)

Minimal, self-contained version of the Smart Moulding Cropper for external testing and batch production.

---

## 실행 위치
```

cd \~/Desktop/Smart/smart-crop-standalone

````

---

## 실행 방법 (Mac / zsh 기준)

### 1) 서버 실행
```bash
cd server
npm install
npm run dev
````

서버 기본 포트: `http://localhost:4000`

---

### 2) 클라이언트 실행

**새 터미널 창**을 열고:

```bash
cd ~/Desktop/Smart/smart-crop-standalone/client
npm install
npm run dev
```

클라이언트 기본 포트: `http://localhost:5173`

---

## 실행 순서 요약

1. 터미널 1: 서버 실행 (`server` 폴더에서 `npm run dev`)
2. 터미널 2: 클라이언트 실행 (`client` 폴더에서 `npm run dev`)
3. 브라우저에서 `http://localhost:5173` 접속

---

## 참고

* Node.js 18+ 필요
* 서버 실행 후 `http://localhost:4000/health` 에 접속하면 상태 확인 가능
* 클라이언트 `.env`에서 `VITE_API_URL`을 서버 주소(`http://localhost:4000`)로 설정해야 함

```

---

바로 복사해서 저장하면, 다음에 회사든 집이든 똑같이 실행할 수 있을 거예요.  
원하면 제가 `.env` 예시까지 포함시켜서 만들어줄 수도 있어요.
```
