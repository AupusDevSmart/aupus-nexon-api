function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convite de operador: link para criar a senha (fluxo /redefinir-senha). */
export function getConviteOperadorEmailHtml(
  nome: string,
  conviteUrl: string,
  frontendUrl: string,
  expiraEmDias: number,
  convidadoPor: string | null,
): string {
  const logoUrl = `${frontendUrl}/logoaupus.png`;
  const quem = convidadoPor ? `${esc(convidadoPor)} convidou você` : 'Você foi convidado';
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Convite NexON - Aupus</title></head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="background-color:#1a1a2e;padding:32px 40px;border-radius:8px 8px 0 0;text-align:center;">
          <img src="${logoUrl}" alt="Aupus" width="140" style="display:block;margin:0 auto;" />
        </td></tr>
        <tr><td style="background-color:#ffffff;padding:40px;border-radius:0 0 8px 8px;color:#1f2937;">
          <p style="font-size:18px;margin:0 0 16px;">Olá, ${esc(nome)}!</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">${quem} para operar no NexON. Crie a sua senha pelo botão abaixo — o acesso só começa a valer depois disso.</p>
          <p style="text-align:center;margin:0 0 24px;">
            <a href="${conviteUrl}" style="display:inline-block;background-color:#177A3C;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;">Criar minha senha</a>
          </p>
          <p style="font-size:13px;line-height:1.6;color:#6b7280;margin:0;">O convite vale por ${expiraEmDias} dia(s). Se o botão não funcionar, copie o endereço: <br><span style="word-break:break-all;">${conviteUrl}</span></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
