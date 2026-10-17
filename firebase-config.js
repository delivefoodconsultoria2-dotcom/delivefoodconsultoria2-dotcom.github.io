/* DeliveRota — configuração do login (Firebase)
   Enquanto estiver null, o app funciona em MODO TESTE: as contas ficam só neste aparelho.
   Para login de verdade (a mesma conta em qualquer celular), cole aqui a configuração do
   seu projeto Firebase. Passo a passo no LEIA-ME.txt, seção 7. Exemplo:

window.DELIVEROTA_FIREBASE = {
  apiKey: "AIza...",
  authDomain: "deliverota.firebaseapp.com",
  projectId: "deliverota",
  appId: "1:123:web:abc"
};
*/
window.DELIVEROTA_FIREBASE = {
  apiKey: "AIzaSyCUPf_rMnBhtdWdUPJ7BQEhsXsggQqkj0k",
  authDomain: "deliverota.firebaseapp.com",
  projectId: "deliverota",
  storageBucket: "deliverota.firebasestorage.app",
  messagingSenderId: "198822343603",
  appId: "1:198822343603:web:fa88e189e33bb41b0a91c6"
};

/* Contas master (podem cadastrar entregadores) */
window.DELIVEROTA_ADMINS = ["delivefoodconsultoria@gmail.com", "delivefoodconsultoria2@gmail.com"];

/* Link da videoaula (YouTube, Google Drive, etc.). Cole o link entre as aspas.
   Exemplo: window.DELIVEROTA_VIDEO_URL = "https://youtu.be/xxxxxxxx"; */
window.DELIVEROTA_VIDEO_URL = "";

/* Servidor de planos e pagamento (Hostinger). Vazio = sem planos, tudo liberado.
   Quando o servidor estiver no ar, coloque o endereço da pasta api, por exemplo:
   window.DELIVEROTA_API = "https://deliverota.delivefoodconsultoria.com.br/api/"; */
window.DELIVEROTA_API = "";
